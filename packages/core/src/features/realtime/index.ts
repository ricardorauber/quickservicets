import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  tenantRuns,
  addOutboxPatterns,
  defineFeature,
  defineSse,
  deferRequestLog,
  duration,
  hook,
  HttpError,
  integer,
  list,
  provider,
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
  type FeatureSetupContext,
  type EntityModel,
  type WriteEvent,
} from "../public.ts";
import type { ChangeDelivery, ChangeSend, RealtimeApi } from "./api.ts";
import { CHANGE_EVENTS, changeEntities, changesPath, documentChanges, parseChangeQuery, type ChangeCoverage, type ChangeEvent } from "./changes.ts";
import { followChanges } from "./follow.ts";
import { outboxSource, ringBufferSource, type ChangeSource } from "./source.ts";
import { openStream, type HeartbeatTimer, type OpenStream } from "./stream.ts";

const options = object({
  sse: toggle({
    heartbeat: duration().default("15s").describe("How often an open stream writes a ping comment, so proxies and clients keep it open."),
    maxStreams: integer().min(1).default(1000).describe("The most streams one worker keeps open; more are refused with 503 and Retry-After: 5."),
    changes: oneOf(["tagged", "all"])
      .default("tagged")
      .describe("Which entities get a change stream route: tagged for entities tagged @changes, all for every entity with list routes without @changes off."),
    pollInterval: duration().default("1s").describe("How often a worker with open change streams reads the outbox log, when events.outbox is on."),
    buffer: integer().min(1).default(1000).describe("How many change events each worker keeps for reconnecting clients, when events.outbox is off."),
    events: list(oneOf(["created", "updated", "deleted"]))
      .default(["created", "updated", "deleted"])
      .describe("The write events change streams offer; @changes events=created limits one entity, and a client asking for others gets 400."),
    beforeDeliver: hook<ChangeDelivery | false, undefined>().describe(
      "Runs for each change and open change stream with the request, its user and tenant, the event and the entity; returning false skips the change for that stream, and a throw skips it and is logged.",
    ),
    beforeSend: hook<ChangeSend | null, undefined>().describe("Runs before each change message is written with the request, the event and the data; it returns changed data, or null to skip the message."),
    changeSource: provider<ChangeSource>("ChangeSource", ["subscribe", "replay"])
      .optional()
      .describe("Replaces the outbox and ring buffer sources: subscribe delivers live write events of some entities, and replay the ones after an event id or expired."),
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

/** The change source of the running service, which `publish` reaches. */
let published: (ChangeSource & { publish(event: WriteEvent): void }) | undefined;

/** Whether a `beforeSend` result is a whole step rather than just its data. */
const isSendStep = (value: unknown): value is ChangeSend => typeof value === "object" && value !== null && "data" in value && "event" in value && "req" in value;

/** A source that also delivers the changes other features publish to this worker's open streams. */
function withPublish(source: ChangeSource): ChangeSource & { publish(event: WriteEvent): void } {
  const local = new Map<string, Set<(event: WriteEvent) => void>>();
  return {
    subscribe(entities, onEvent) {
      const stop = source.subscribe(entities, onEvent);
      for (const entity of entities) {
        let set = local.get(entity);
        if (!set) local.set(entity, (set = new Set()));
        set.add(onEvent);
      }
      return () => {
        stop();
        for (const entity of entities) local.get(entity)?.delete(onEvent);
      };
    },
    replay: (entities, afterId, limit) => source.replay(entities, afterId, limit),
    publish(event) {
      for (const fn of [...(local.get(event.entity) ?? [])]) fn(event);
    },
  };
}

const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/**
 * Where the change streams of a worker get their events: the outbox log, shared by every worker and replica, when
 * `events.outbox` is on; otherwise a ring buffer of this worker's own committed writes.
 */
function changeSource(ctx: FeatureSetupContext<{ sse: { pollInterval: string; buffer: number; changeSource?: ChangeSource } }>, covered: readonly EntityModel[]): ChangeSource {
  if (ctx.options.sse.changeSource) return ctx.options.sse.changeSource;
  const patterns = covered.map((entity) => `${lowerFirst(entity.entityName)}.written`);
  const outbox = ctx.config.features.find((feature) => feature.key === "events")?.options.outbox as { enabled?: boolean; retention?: string } | undefined;
  if (outbox?.enabled) {
    addOutboxPatterns(patterns);
    return outboxSource({
      pollMs: parseDuration(ctx.options.sse.pollInterval) ?? 1000,
      retentionMs: parseDuration(outbox.retention) ?? 7 * 86_400_000,
      onPollFailed: (error) =>
        safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "realtime.poll.failed", error: { message: (error as Error)?.message ?? String(error) } }),
    });
  }
  if ((ctx.config.server.workers ?? 1) > 1) {
    safeLog(ctx.logger, "warn", {
      timestamp: new Date().toISOString(),
      message: "realtime change streams see only the writes of their own worker; enable events: { outbox: true } to share them",
    });
  }
  const ring = ringBufferSource(ctx.options.sse.buffer);
  for (const pattern of patterns) ctx.events.on(pattern, (event) => ring.push(event as WriteEvent));
  return ring;
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
      scope: "sse",
      options: ["events"],
      description:
        "`@changes` gives the entity a change stream at `GET /<collection>/changes`, `@changes events=created,deleted` limits the events it offers, and `@changes off` removes it when `sse.changes` is `all`.",
      example: "/** @changes events=created,deleted */\nexport type Task = { title: string; status: string };",
    },
  },
  // Project endpoint files at the change streams' paths replace them; the build says so.
  build(ctx) {
    if (!ctx.options.sse.enabled) return;
    for (const entity of changeEntities(ctx.models, ctx.options.sse.changes as ChangeCoverage)) {
      const file = `endpoints${changesPath(entity)}/sse.ts`;
      if (existsSync(join(ctx.root, file))) ctx.log(`Override: ${file} replaces GET ${changesPath(entity)} from realtime`);
    }
  },
  setup(ctx) {
    const sse = ctx.options.sse;
    published = undefined;
    if (!sse.enabled) return;
    /** The events an entity's stream offers: its `@changes events=` tag, else `sse.events`. */
    const offered = (entity: EntityModel) => ((entity.tags?.changes?.options.events as ChangeEvent[] | undefined) ?? (sse.events as ChangeEvent[])).filter((name) => (CHANGE_EVENTS as readonly string[]).includes(name));
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
      if (!ctx.config.features.some((feature) => feature.key === "events")) throw new Error("realtime change streams require events; add events: {} to quickservicets.config.ts");
      const source = withPublish(changeSource(ctx, covered));
      published = source;
      const { beforeDeliver, beforeSend } = sse;
      const hookFailed = (hookName: string, error: unknown) =>
        safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "feature.hook.failed", feature: "realtime", hook: `sse.${hookName}`, error: { message: (error as Error)?.message ?? String(error) } });
      /** The `beforeDeliver` hooks for one stream: false from any of them, or a throw, skips the change. */
      const acceptsFor = (req: ServiceRequest, entity: string) =>
        beforeDeliver.length === 0
          ? undefined
          : async (event: WriteEvent) => {
              for (const fn of beforeDeliver) {
                try {
                  if ((await fn({ req, user: req.user, tenant: req.tenant, event, entity }, undefined)) === false) return false;
                } catch (error) {
                  hookFailed("beforeDeliver", error);
                  return false;
                }
              }
              return true;
            };
      /** The `beforeSend` hooks for one stream: each may change the data, null skips the message, and a throw skips it. */
      const transformFor = (req: ServiceRequest) =>
        beforeSend.length === 0
          ? undefined
          : async (event: WriteEvent, data: unknown) => {
              let current = data;
              for (const fn of beforeSend) {
                try {
                  const result = (await fn({ req, event, data: current }, undefined)) as unknown;
                  if (result === null) return null;
                  if (result !== undefined) current = isSendStep(result) ? result.data : result;
                } catch (error) {
                  hookFailed("beforeSend", error);
                  return null;
                }
              }
              return current;
            };
      const files = { storage: ctx.config.storage, files: ctx.config.files, ...(ctx.config.server.publicUrl ? { publicUrl: ctx.config.server.publicUrl } : {}) };
      for (const entity of covered) {
        // The stream runs the hooks of the entity's list route, so whoever may not list records may not follow them.
        const hooks = resolveRouteHooks({ kind: "generated", entity, operation: "list" });
        ctx.app.route(
          "GET",
          changesPath(entity),
          (repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
            const query = parseChangeQuery(entity, req.query, ctx.models, offered(entity));
            const accepts = acceptsFor(req, entity.entityName);
            const transform = transformFor(req);
            const follow = defineSse((stream) =>
              followChanges(stream, {
                entity,
                query,
                source,
                files,
                ...(req.lastEventId !== undefined ? { lastEventId: req.lastEventId } : {}),
                ...(accepts ? { accepts } : {}),
                ...(transform ? { transform } : {}),
                // With tenancy, a stream sees only its own tenant's changes (or, without a tenant, only untenanted ones).
                ...(tenantRuns() ? { tenant: (req.tenant as { id?: string } | undefined)?.id ?? null } : {}),
              }),
            );
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
      published = undefined;
    });
  },
  api: (ctx): RealtimeApi => ({
    beforeDeliver: (fn) => void (ctx.options.sse.beforeDeliver as unknown[]).push(fn),
    beforeSend: (fn) => void (ctx.options.sse.beforeSend as unknown[]).push(fn),
    publish(entity, event) {
      published?.publish({ ...event, entity });
    },
  }),
  openapi(doc, { models, options }) {
    return options.sse.enabled ? documentChanges(doc, changeEntities(models, options.sse.changes as ChangeCoverage)) : doc;
  },
});

export default realtimeFeature;
export { realtimeFeature };
export { encodeComment, encodeMessage, openStream } from "./stream.ts";
export { CHANGE_EVENTS, changeEntities, changeMessage, changesPath, hasChangeStream, parseChangeQuery } from "./changes.ts";
export type { ChangeCoverage, ChangeEvent, ChangeMessage, ChangeQuery } from "./changes.ts";
export { followChanges, MAX_REPLAY, RETRY_MS } from "./follow.ts";
export type { ResetReason } from "./follow.ts";
export { eventIdFloor, isEventId, outboxSource, POLL_OVERLAP_MS, ringBufferSource, timeOfEventId } from "./source.ts";
export type { ChangeSource } from "./source.ts";
export type { HeartbeatTimer, OpenStream } from "./stream.ts";
export type { ChangeDelivery, ChangeSend, RealtimeApi } from "./api.ts";
