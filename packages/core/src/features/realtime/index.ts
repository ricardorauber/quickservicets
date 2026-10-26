import { defineFeature, deferRequestLog, duration, HttpError, integer, object, parseDuration, safeLog, setSseRunner, toggle, type ServiceRequest, type SseRunner } from "../public.ts";
import { openStream, type HeartbeatTimer, type OpenStream } from "./stream.ts";

const options = object({
  sse: toggle({
    heartbeat: duration().default("15s").describe("How often an open stream writes a ping comment, so proxies and clients keep it open."),
    maxStreams: integer().min(1).default(1000).describe("The most streams one worker keeps open; more are refused with 503 and Retry-After: 5."),
  }).describe("Serves the sse.ts endpoints as Server-Sent Events streams."),
});

/** The headers of every Server-Sent Events response. */
export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

/** The `Last-Event-ID` header of a request, else its `lastEventId` query parameter. */
export const lastEventIdOf = (req: Pick<ServiceRequest, "headers" | "query">): string | undefined => req.headers.get("last-event-id") ?? req.query.get("lastEventId") ?? undefined;

/** The streams one worker keeps open, and the runner that opens them. */
export function streamRunner(settings: { heartbeatMs: number; maxStreams: number; log: (entry: Record<string, unknown>) => void; timer?: HeartbeatTimer }) {
  const open = new Set<OpenStream>();
  const run: SseRunner = async (definition, repos, req) => {
    if (open.size >= settings.maxStreams) throw new HttpError(503, "Too many open streams", { headers: { "retry-after": "5" } });
    const opened: OpenStream = openStream({ heartbeatMs: settings.heartbeatMs, ...(settings.timer ? { timer: settings.timer } : {}), onClose: () => open.delete(opened) });
    open.add(opened);
    const response = new Response(opened.body, { status: 200, headers: SSE_HEADERS });
    deferRequestLog(
      response,
      opened.stream.closed.then(() => ({ messages: opened.messages() })),
    );
    // The handler runs with the stream open; the stream stays open after it resolves, and closes when it rejects.
    void Promise.resolve()
      .then(() => definition.handler(opened.stream, repos, req))
      .catch((error: unknown) => {
        settings.log({ message: "sse.handler.failed", requestId: req.id, error: { message: (error as Error)?.message ?? String(error), ...(error instanceof Error ? { stack: error.stack } : {}) } });
        opened.stream.close();
      });
    return response;
  };
  return {
    run,
    /** The streams open now. */
    count: () => open.size,
    /** Closes every open stream. */
    closeAll() {
      for (const stream of [...open]) stream.stream.close();
    },
  };
}

/**
 * The `realtime` native: `sse.ts` endpoints stream Server-Sent Events to clients, with heartbeats, a stream limit per
 * worker and the endpoint's pre-hooks. Off unless `realtime: {}` (or `QS_REALTIME_ENABLED=true`) is set.
 */
const realtimeFeature = defineFeature({
  key: "realtime",
  docs: { summary: "Server-Sent Events endpoints from sse.ts files, with heartbeats, disconnect handling and a stream limit per worker." },
  options,
  request: { lastEventId: lastEventIdOf },
  setup(ctx) {
    const sse = ctx.options.sse;
    if (!sse.enabled) return;
    const heartbeatMs = parseDuration(sse.heartbeat) ?? 15_000;
    const runner = streamRunner({
      heartbeatMs,
      maxStreams: sse.maxStreams,
      log: (entry) => safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), ...entry }),
    });
    setSseRunner(runner.run);
    // Idle connections closed by the security timeouts would cut streams quieter than the heartbeat.
    const timeouts = ctx.config.features.find((feature) => feature.key === "security")?.options.timeouts as { enabled?: boolean; idle?: string } | undefined;
    const idleMs = timeouts?.enabled ? parseDuration(timeouts.idle) : undefined;
    if (idleMs !== undefined && idleMs > 0 && heartbeatMs >= idleMs) {
      safeLog(ctx.logger, "warn", {
        timestamp: new Date().toISOString(),
        message: `realtime.sse.heartbeat (${sse.heartbeat}) should be shorter than security.timeouts.idle (${timeouts!.idle}), or idle streams will be closed`,
      });
    }
    // Open streams end before the listener closes, so a shutdown never waits on them.
    ctx.app.onShutdown(() => runner.closeAll());
    ctx.app.onStop(() => {
      runner.closeAll();
      setSseRunner(undefined);
    });
  },
});

export default realtimeFeature;
export { realtimeFeature };
export { encodeComment, encodeMessage, openStream } from "./stream.ts";
export type { HeartbeatTimer, OpenStream } from "./stream.ts";
