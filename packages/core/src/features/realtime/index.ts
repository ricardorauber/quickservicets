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
  rate,
  size,
  string,
  parseRate,
  parseSize,
  anyOf,
  localTransport,
  setSocketHub,
  type SocketTransport,
  type Socket,
  resolveOption,
  sockets,
  taggedRoutes,
  type OptionFunction,
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
import { CLOSE_CODES, socketServer, type SocketConnect, type SocketHooks, type SocketLimits } from "./sockets.ts";
import { postgresTransport, socketChannel } from "./postgres-transport.ts";

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
  websockets: toggle({
    origins: list(string())
      .optional()
      .perRequest()
      .describe("Browser origins allowed to open sockets besides the service's own; security.cors.origins when unset. Requests without Origin (non-browser clients) always pass."),
    maxConnections: integer().min(1).default(10000).describe("The most sockets one worker keeps open; more upgrades answer 503 with Retry-After: 5."),
    maxMessageSize: size().default("1MB").describe("The largest frame a socket accepts; a larger one closes the socket with 1009, and one over twice the limit ends the connection."),
    idleTimeout: duration().default("120s").describe("How long a socket may stay silent before it is closed, at most 960s; Bun pings to keep live connections open."),
    messages: rate()
      .default("100/10s")
      .perRequest()
      .describe("The frames each socket may send per window; exceeding it closes the socket with 1008 Too many messages. A function of the upgrade request, its user and tenant decides it per connection."),
    maxRooms: integer().min(1).default(100).describe("The most rooms one socket joins; one more subscribe throws Socket joined too many rooms."),
    transport: anyOf(oneOf(["local", "postgres"]), provider<SocketTransport>("SocketTransport", ["start", "publish", "disconnect", "stop"]))
      .default("local")
      .describe(
        'How room messages and disconnects reach the sockets of other workers and replicas: "local" keeps them in this process, "postgres" uses LISTEN and NOTIFY on the project\'s PostgreSQL database, and a SocketTransport delivers them its own way.',
      ),
    postgres: object({
      channel: string().default("quickservicets_sockets").describe("The notification channel of the postgres transport; with _ and the default schema added when one is set (quickservicets_sockets_tenant_a for tenant-a)."),
      maxPayload: size().default(7900).describe("The largest envelope the postgres transport sends, under PostgreSQL's 8000-byte limit; larger messages reach local sockets only."),
    })
      .default({ channel: "quickservicets_sockets", maxPayload: 7900 })
      .describe("The settings of the postgres transport."),
    beforeConnect: hook<SocketConnect, undefined>().describe("Runs before an upgrade, after the pre-hooks, with the request, its user and tenant and the route; a thrown HttpError refuses the upgrade with it."),
    afterConnect: hook<{ ws: Socket }, undefined>().describe("Runs once a socket is open and its open handler ran; a failure is logged."),
    beforeMessage: hook<{ ws: Socket; data: unknown }, undefined>().describe("Runs for each frame before its handler; it returns changed data, or null to drop the frame."),
    beforeSubscribe: hook<{ ws: Socket; room: string } | boolean, undefined>().describe("Runs synchronously when a socket joins a room; returning false makes subscribe throw Not allowed to join, followed by the room."),
    beforePublish: hook<{ room: string; data: unknown; ws?: Socket }, undefined>().describe("Runs before each publish to a room, with the socket that publishes, if any; it returns changed data, or null to drop the publish."),
    onClose: hook<{ ws: Socket; code: number; reason: string; durationMs: number }, undefined>().describe("Runs after a socket closed, with the close code, the reason and how long it was open; a failure is logged."),
  }).describe("Serves the ws.ts endpoints as WebSockets, upgraded after the handler middlewares and the endpoint's pre-hooks."),
});

/** The longest idle timeout Bun accepts for sockets, in seconds. */
const MAX_SOCKET_IDLE_SECONDS = 960;

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

/** The socket state of each running setup, for the feature API. */
interface SocketState {
  server: ReturnType<typeof socketServer> | undefined;
  /** The transport the config or a feature chose, and who chose it. */
  transport: SocketTransport | undefined;
  owner: string | undefined;
  /** Set once a feature used the sockets API during setup, so the transport starts without ws.ts routes. */
  used: boolean;
  open: boolean;
}

const socketStates = new WeakMap<object, SocketState>();

/** Whether this process already warned about the local transport with several workers. */
let warnedLocal = false;

type SocketOptions = {
  websockets: {
    enabled: boolean;
    origins?: string[] | OptionFunction<string[]>;
    maxConnections: number;
    maxMessageSize: string | number;
    idleTimeout: string;
    messages: string | OptionFunction<string>;
    maxRooms: number;
    transport: "local" | "postgres" | SocketTransport;
    postgres: { channel: string; maxPayload: string | number };
  };
};

/**
 * The limits of each upgrade: its route's `@socket` options over the global ones, and the message rate of a function,
 * decided once per connection; a route's options are read once.
 */
function socketLimits(options: SocketOptions["websockets"]): (req: ServiceRequest) => Promise<SocketLimits> {
  const routes = new Map<string, { maxMessageSize: number; messages: string | OptionFunction<string>; origins?: string[] | OptionFunction<string[]>; tagged: boolean }>();
  return async (req) => {
    const key = `${req.method} ${req.route}`;
    let route = routes.get(key);
    if (!route) {
      const target = realtimeFeature.optionsFor(req);
      const scoped = target.websockets as unknown as SocketOptions["websockets"];
      const tag = target.on !== undefined;
      route = {
        maxMessageSize: parseSize(scoped.maxMessageSize) ?? 1_048_576,
        messages: scoped.messages,
        ...(tag && scoped.origins !== options.origins && scoped.origins !== undefined ? { origins: scoped.origins } : {}),
        tagged: tag,
      };
      routes.set(key, route);
    }
    const rate = typeof route.messages === "function" ? await resolveOption(route.messages, { req }) : route.messages;
    return { maxMessageSize: route.maxMessageSize, messages: parseRate(rate), ...(route.origins !== undefined ? { origins: route.origins } : {}) };
  };
}

/**
 * Serves the `ws.ts` endpoints while `websockets` is on: Bun gets a WebSocket handler only when such a route exists,
 * and the transport starts when one exists or a feature used the sockets API during setup.
 */
function setUpSockets(ctx: FeatureSetupContext<SocketOptions>): void {
  const options = ctx.options.websockets;
  const state: SocketState = { server: undefined, transport: undefined, owner: undefined, used: false, open: true };
  socketStates.set(ctx.options, state);
  if (!options.enabled) return;
  if (typeof options.transport === "object") {
    state.transport = options.transport;
    state.owner = "the config (realtime.websockets.transport)";
  } else if (options.transport === "postgres") {
    const database = ctx.config.database;
    if (database.kind !== "postgres" || typeof database.listen !== "function" || typeof database.notify !== "function") {
      throw new Error('realtime.websockets.transport "postgres" needs the PostgreSQL adapter');
    }
    const transport = postgresTransport({
      adapter: database,
      channel: socketChannel(options.postgres.channel, ctx.config.schema ?? undefined),
      maxPayload: parseSize(options.postgres.maxPayload) ?? 7900,
    });
    state.transport = transport;
    state.owner = "the config (realtime.websockets.transport)";
    // The listening connection is part of readiness, without failing it: room messages are best effort.
    if (ctx.config.features.some((feature) => feature.key === "health")) ctx.feature("health").check("transport", () => transport.probe(), { critical: false });
  }
  const security = ctx.config.features.find((feature) => feature.key === "security")?.options as
    | { proxy?: { enabled?: boolean; trust?: readonly string[] }; cors?: { enabled?: boolean; origins?: string[] | OptionFunction<string[]> } }
    | undefined;
  const server = socketServer({
    maxConnections: options.maxConnections,
    maxMessageSize: parseSize(options.maxMessageSize) ?? 1_048_576,
    idleTimeout: Math.ceil((parseDuration(options.idleTimeout) ?? 120_000) / 1000),
    messages: parseRate(typeof options.messages === "string" ? options.messages : "100/10s"),
    origins: options.origins ?? (security?.cors?.enabled ? security.cors.origins : undefined),
    proxy: security?.proxy,
    logger: ctx.logger,
    maxRooms: options.maxRooms,
    tenantRooms: ctx.config.features.some((feature) => feature.key === "tenancy"),
    limitsFor: socketLimits(options),
    hooks: options as unknown as Partial<SocketHooks>,
  });
  state.server = server;
  setSocketHub(server.sockets);
  const hasSockets = taggedRoutes().some((route) => route.kind === "websocket");
  if (hasSockets) {
    ctx.app.configureServer({ websocket: server.handler as never, socketRunner: server.run });
    // Revoking a session closes its sockets.
    if (ctx.config.features.some((feature) => feature.key === "auth")) {
      ctx.feature("auth").onRevoke((target) =>
        void server.sockets.disconnect({ ...("sessionId" in target ? { sessionId: target.sessionId } : { user: target.userId }), code: 4401, reason: "Session revoked" }),
      );
    }
  }
  ctx.app.onStart(async () => {
    state.open = false;
    if (!hasSockets && !state.used) return;
    if (!state.transport && ctx.config.server.workers > 1 && !warnedLocal) {
      warnedLocal = true;
      safeLog(ctx.logger, "warn", {
        timestamp: new Date().toISOString(),
        message: "realtime.websockets uses the local transport; sockets on other workers will not receive room messages; configure realtime.websockets.transport",
      });
    }
    await server.startTransport(state.transport ?? localTransport());
  });
  // Open sockets close before the listener does, so a shutdown never waits on them.
  ctx.app.onShutdown(() => server.closeAll(CLOSE_CODES.goingAway, "Server shutting down"));
  ctx.app.onStop(async () => {
    server.closeAll(CLOSE_CODES.goingAway, "Server shutting down");
    await server.stopTransport();
    setSocketHub(undefined, server.sockets);
  });
}

/**
 * The `realtime` native: `sse.ts` endpoints stream Server-Sent Events to clients, with heartbeats, a stream limit per
 * worker and the endpoint's pre-hooks. Off unless `realtime: {}` (or `QS_REALTIME_ENABLED=true`) is set.
 */
const realtimeFeature = defineFeature({
  key: "realtime",
  docs: {
    summary: "Server-Sent Events endpoints from sse.ts files and WebSocket endpoints from ws.ts files, with limits per worker and per socket.",
    sections: [
      {
        title: "The sockets API",
        text: [
          "`sockets` of `@quickservicets/core` (and `ctx.feature(\"realtime\").sockets()` in a feature) reaches the sockets from any code:",
          "",
          "- `sockets.publish(room, data, { except?, tenant? })` sends to every socket of a room, here at once and on other workers through `websockets.transport`.",
          "- `sockets.disconnect({ user?, sessionId?, tenant?, room?, code?, reason? })` closes the matching sockets (default code 4001) and returns the local count.",
          "- `sockets.count(room, { tenant? })` counts this worker's sockets in a room.",
          "",
          "A socket offers `send`, `close`, `subscribe`, `unsubscribe`, `publish`, `rooms`, `id`, `user`, `tenant`, `params`, `data` and `readyState`.",
        ].join("\n"),
      },
      {
        title: "Close codes",
        text: [
          "| Code | Reason |",
          "| --- | --- |",
          "| 1001 | Server shutting down |",
          "| 1008 | Too many messages |",
          "| 1009 | Message too big |",
          "| 1011 | Internal error (a handler threw an error other than `HttpError`) |",
          "| 4001 | Disconnected (`sockets.disconnect`) |",
          "| 4401 | Session revoked |",
        ].join("\n"),
      },
      {
        title: "Error codes",
        text: [
          "| Status | Code | Message |",
          "| --- | --- | --- |",
          "| 403 | `FORBIDDEN` | Origin not allowed |",
          "| 426 | `UPGRADE_REQUIRED` | This route needs a WebSocket connection |",
          "| 503 | `SERVICE_UNAVAILABLE` | Too many open sockets |",
          "",
          "Typed sockets answer the error frames `INVALID_MESSAGE` and `UNKNOWN_MESSAGE_TYPE`.",
        ].join("\n"),
      },
    ],
  },
  options,
  validate(resolved) {
    const idle = resolved.websockets.enabled ? parseDuration(resolved.websockets.idleTimeout) : undefined;
    return idle !== undefined && idle > MAX_SOCKET_IDLE_SECONDS * 1000
      ? [`Invalid realtime.websockets.idleTimeout: expected at most ${MAX_SOCKET_IDLE_SECONDS}s (the Bun limit), got ${resolved.websockets.idleTimeout}`]
      : [];
  },
  // Change streams follow the write events when the events native is on; sockets of revoked sessions close.
  after: ["events", "auth", "health"],
  request: { lastEventId: lastEventIdOf },
  tags: {
    socket: {
      on: ["endpoint"],
      scope: "websockets",
      options: ["maxMessageSize", "messages", "origins"],
      description:
        "Gives one ws.ts route its own limits: `@socket messages=10/s` its message rate, `@socket maxMessageSize=64KB` a smaller frame limit (at most the global one), and `@socket origins=https://game.example` the browser origins allowed to connect.",
      example: "/** @socket messages=10/s origins=https://game.example */\nexport default defineSocket({ message: (ws, data) => ws.send(data) });",
      check: (tag, options) => {
        const global = parseSize((options.websockets as { maxMessageSize: string | number }).maxMessageSize) ?? 0;
        const own = tag.maxMessageSize === undefined ? undefined : parseSize(tag.maxMessageSize as string | number);
        return own !== undefined && own > global ? "maxMessageSize is above realtime.websockets.maxMessageSize" : undefined;
      },
    },
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
    setUpSockets(ctx);
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
          { hooks, entity: entity.key, operation: "list" },
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
    sockets() {
      const state = socketStates.get(ctx.options);
      if (state?.open) state.used = true;
      return state?.server?.sockets ?? sockets;
    },
    addHook(name, fn) {
      const hooks = ["beforeConnect", "afterConnect", "beforeMessage", "beforeSubscribe", "beforePublish", "onClose"];
      if (!hooks.includes(name)) throw new Error(`Unknown hook ${name} of realtime.websockets`);
      if (typeof fn !== "function") throw new Error(`Hook ${name} of realtime must be a function`);
      (ctx.options.websockets as unknown as Record<string, unknown[]>)[name]!.push(fn);
    },
    setTransport(transport) {
      const state = socketStates.get(ctx.options);
      const caller = ctx.currentFeature() ?? "a feature";
      if (!state?.open) throw new Error("realtime setTransport() is only available during setup");
      for (const method of ["start", "publish", "disconnect", "stop"] as const) {
        if (typeof transport?.[method] !== "function") throw new Error("realtime setTransport() expects a SocketTransport with the methods start, publish, disconnect, stop");
      }
      if (state.owner !== undefined) throw new Error(`realtime.websockets.transport is set by both ${state.owner} and ${caller}`);
      state.owner = caller;
      state.transport = transport;
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
export { postgresTransport, socketChannel } from "./postgres-transport.ts";
export type { PostgresTransport, PostgresTransportOptions } from "./postgres-transport.ts";
export type { SocketConnect, SocketHooks, SocketLimits } from "./sockets.ts";
export type { ResetReason } from "./follow.ts";
export { eventIdFloor, isEventId, outboxSource, POLL_OVERLAP_MS, ringBufferSource, timeOfEventId } from "./source.ts";
export type { ChangeSource } from "./source.ts";
export type { HeartbeatTimer, OpenStream } from "./stream.ts";
export type { ChangeDelivery, ChangeSend, RealtimeApi } from "./api.ts";
