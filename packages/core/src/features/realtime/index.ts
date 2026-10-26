import {
  defineFeature,
  defineSse,
  deferRequestLog,
  duration,
  HttpError,
  integer,
  object,
  oneOf,
  parseDuration,
  resolveRouteHooks,
  safeLog,
  setSseRunner,
  toggle,
  type Repositories,
  type ServiceRequest,
  type ServiceResponse,
  type SseRunner,
  type WriteEvent,
} from "../public.ts";
import { changeEntities, changeHub, changeMessage, changesPath, documentChanges, parseChangeQuery, type ChangeCoverage } from "./changes.ts";
import { openStream, type HeartbeatTimer, type OpenStream } from "./stream.ts";

const options = object({
  sse: toggle({
    heartbeat: duration().default("15s").describe("How often an open stream writes a ping comment, so proxies and clients keep it open."),
    maxStreams: integer().min(1).default(1000).describe("The most streams one worker keeps open; more are refused with 503 and Retry-After: 5."),
    changes: oneOf(["tagged", "all"])
      .default("tagged")
      .describe("Which entities get a change stream route: tagged for entities tagged @changes, all for every entity with list routes without @changes off."),
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
  // Change streams follow the write events when the events native is on.
  after: ["events"],
  request: { lastEventId: lastEventIdOf },
  tags: {
    changes: {
      on: ["entity"],
      description: "`@changes` gives the entity a change stream at `GET /<collection>/changes`, and `@changes off` removes it when `sse.changes` is `all`.",
      example: "/** @changes */\nexport type Task = { title: string; status: string };",
    },
  },
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
    const covered = changeEntities(ctx.models, sse.changes as ChangeCoverage);
    if (covered.length > 0) {
      if (!ctx.config.features.some((feature) => feature.key === "events")) throw new Error("realtime change streams require events; add events: {} to quickservice.config.ts");
      const hub = changeHub((pattern, listener) => ctx.events.on(pattern, listener as never));
      const files = { storage: ctx.config.storage, files: ctx.config.files, ...(ctx.config.server.publicUrl ? { publicUrl: ctx.config.server.publicUrl } : {}) };
      for (const entity of covered) {
        // The stream runs the hooks of the entity's list route, so whoever may not list records may not follow them.
        const hooks = resolveRouteHooks({ kind: "generated", entity, operation: "list" });
        ctx.app.route(
          "GET",
          changesPath(entity),
          (repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
            const query = parseChangeQuery(entity, req.query, ctx.models);
            const follow = defineSse((stream) => {
              // Messages go out in commit order, one after the other.
              let queue = Promise.resolve();
              const unsubscribe = hub.subscribe(entity, (event: WriteEvent) => {
                queue = queue.then(async () => {
                  const message = await changeMessage(event, entity, query, files);
                  if (message) stream.send(message.data, { event: message.event, id: message.id });
                });
              });
              stream.signal.addEventListener("abort", unsubscribe, { once: true });
            });
            return runner.run(follow, repos, req, res);
          },
          { hooks },
        );
      }
    }
    // Open streams end before the listener closes, so a shutdown never waits on them.
    ctx.app.onShutdown(() => runner.closeAll());
    ctx.app.onStop(() => {
      runner.closeAll();
      setSseRunner(undefined);
    });
  },
  openapi(doc, { models, options }) {
    return options.sse.enabled ? documentChanges(doc, changeEntities(models, options.sse.changes as ChangeCoverage)) : doc;
  },
});

export default realtimeFeature;
export { realtimeFeature };
export { encodeComment, encodeMessage, openStream } from "./stream.ts";
export { CHANGE_EVENTS, changeEntities, changeHub, changeMessage, changesPath, hasChangeStream, parseChangeQuery } from "./changes.ts";
export type { ChangeCoverage, ChangeEvent, ChangeHub, ChangeMessage, ChangeQuery } from "./changes.ts";
export type { HeartbeatTimer, OpenStream } from "./stream.ts";
