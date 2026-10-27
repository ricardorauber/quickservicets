import {
  assertRoomName,
  decodeEnvelopeData,
  encodeEnvelopeData,
  transportOrigin,
  type SocketEnvelope,
  type SocketTransport,
  bunServerOf,
  currentTenant,
  HttpError,
  normalizeOrigin,
  OriginMatcher,
  ownOriginReader,
  REQUEST_LOG,
  resolveOption,
  runForTenant,
  safeLog,
  tenantRuns,
  upgradeRequest,
  runAfterHooks,
  type DisconnectFilter,
  type FeatureHook,
  type Logger,
  type PublishOptions,
  type Sockets,
  type OptionFunction,
  type Rate,
  type Repositories,
  type ServiceRequest,
  type Socket,
  type SocketContext,
  type SocketDefinition,
  type SocketRunner,
} from "../public.ts";

/** The close codes the native uses. */
export const CLOSE_CODES = { normal: 1000, goingAway: 1001, policy: 1008, tooBig: 1009, internal: 1011 } as const;

/** The settings of the WebSocket endpoints of one worker. */
export interface SocketSettings {
  maxConnections: number;
  maxMessageSize: number;
  /** Seconds. */
  idleTimeout: number;
  messages: Rate;
  /** The allowed origins besides the service's own, or a function computing them per request. */
  origins: readonly string[] | OptionFunction<string[]> | undefined;
  proxy: { enabled?: boolean; trust?: readonly string[] } | undefined;
  logger: Logger;
  /** The most rooms one socket joins. */
  maxRooms: number;
  /** Whether rooms are kept apart per tenant (the `tenancy` native is on). */
  tenantRooms: boolean;
  /** The limits of one upgrade: its route's `@socket` options and the per-request message rate (default: the global ones). */
  limitsFor?: (req: ServiceRequest) => SocketLimits | Promise<SocketLimits>;
  /** The hooks around connecting, messages, rooms and closing; empty lists cost nothing. */
  hooks?: Partial<SocketHooks>;
}

/** The limits of one socket. */
export interface SocketLimits {
  maxMessageSize: number;
  messages: Rate;
  /** The origins allowed for its route, when its `@socket` tag lists them. */
  origins?: readonly string[] | OptionFunction<string[]>;
}

/** What `beforeConnect` hooks receive: a throw refuses the upgrade with that error. */
export interface SocketConnect {
  req: ServiceRequest;
  user: ServiceRequest["user"];
  tenant: ServiceRequest["tenant"];
  route: string;
}

/** The hooks of the WebSocket endpoints. */
export interface SocketHooks {
  beforeConnect: readonly FeatureHook<SocketConnect, undefined>[];
  afterConnect: readonly FeatureHook<{ ws: Socket }, undefined>[];
  /** May return changed data, or null to drop the frame. */
  beforeMessage: readonly FeatureHook<{ ws: Socket; data: unknown } | unknown, undefined>[];
  /** Returning false makes `subscribe` throw `Not allowed to join <room>`; runs synchronously. */
  beforeSubscribe: readonly FeatureHook<{ ws: Socket; room: string } | boolean, undefined>[];
  /** May return changed data, or null to drop the publish. */
  beforePublish: readonly FeatureHook<{ room: string; data: unknown; ws?: Socket } | unknown, undefined>[];
  onClose: readonly FeatureHook<{ ws: Socket; code: number; reason: string; durationMs: number }, undefined>[];
}

const NO_HOOKS: SocketHooks = { beforeConnect: [], afterConnect: [], beforeMessage: [], beforeSubscribe: [], beforePublish: [], onClose: [] };

/** Whether a hook's result is its whole step (the hook returned what it received) rather than a changed value. */
const isStep = (value: unknown, keys: readonly string[]) => typeof value === "object" && value !== null && keys.every((key) => key in value);

/** What `ws.send` and `publish` send for a value: strings and bytes as they are, anything else as JSON text. */
export const encodeFrame = (data: unknown): string | Uint8Array => (typeof data === "string" || data instanceof Uint8Array ? data : JSON.stringify(data));

/** The part of a Bun server the rooms use. */
interface BunPublisher {
  publish(topic: string, data: string | Uint8Array): number;
}

/** What the sockets of a worker share: how room names become topics, the room limit and the Bun server. */
interface RoomContext {
  topicOf(room: string, tenant: string | undefined): string;
  maxRooms: number;
  /** Publishes a socket's frame to the other sockets of its topic, here and through the transport. */
  publishFrom(socket: OpenSocket, room: string, topic: string, data: unknown): void;
  /** Runs the `beforeSubscribe` hooks; false refuses the room. */
  mayJoin(socket: OpenSocket, room: string): boolean;
}

/** What Bun keeps with each upgraded socket. */
interface SocketData {
  socket: OpenSocket;
}

/** The part of Bun's `ServerWebSocket` the native uses. */
interface BunSocket {
  data: SocketData;
  readyState: number;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: string | Uint8Array): number;
  isSubscribed(topic: string): boolean;
}

/** One open socket of this worker, with the upgrade request's context and its counters. */
export class OpenSocket implements Socket {
  readonly id = Bun.randomUUIDv7();
  data: Record<string, unknown> = {};
  ws: BunSocket | undefined;
  messagesIn = 0;
  messagesOut = 0;
  readonly openedAt = performance.now();
  windowStart = 0;
  windowCount = 0;
  closeCode: number | undefined;
  /** The rooms the socket joined, by name. */
  readonly joined = new Set<string>();

  constructor(
    readonly definition: SocketDefinition,
    readonly ctx: SocketContext,
    readonly route: string,
    readonly requestId: string,
    private readonly rooms_: RoomContext,
    /** The session of the upgrade request's credentials, for disconnects by session. */
    readonly sessionId: string | undefined,
    /** The frame size and message rate of this socket. */
    readonly limits: SocketLimits,
  ) {}

  /** The tenant id of the socket, if any. */
  get tenantId(): string | undefined {
    return (this.ctx.tenant as { id?: string } | undefined)?.id;
  }

  get rooms(): readonly string[] {
    return [...this.joined];
  }

  subscribe(room: string): void {
    assertRoomName(room);
    if (this.joined.has(room)) return;
    if (this.joined.size >= this.rooms_.maxRooms) throw new Error(`Socket joined too many rooms (max ${this.rooms_.maxRooms})`);
    if (!this.rooms_.mayJoin(this, room)) throw new Error(`Not allowed to join ${room}`);
    this.joined.add(room);
    this.ws?.subscribe(this.rooms_.topicOf(room, this.tenantId));
  }

  unsubscribe(room: string): void {
    assertRoomName(room);
    if (!this.joined.delete(room)) return;
    this.ws?.unsubscribe(this.rooms_.topicOf(room, this.tenantId));
  }

  publish(room: string, data: unknown): void {
    assertRoomName(room);
    this.rooms_.publishFrom(this, room, this.rooms_.topicOf(room, this.tenantId), data);
  }

  get user() {
    return this.ctx.user;
  }
  get tenant() {
    return this.ctx.tenant;
  }
  get params() {
    return this.ctx.params;
  }
  get readyState(): number {
    return this.ws?.readyState ?? 0;
  }

  send(data: unknown): void {
    if (!this.ws) return;
    this.messagesOut += 1;
    this.ws.send(encodeFrame(data));
  }

  close(code: number = CLOSE_CODES.normal, reason?: string): void {
    this.closeCode ??= code;
    this.ws?.close(code, reason);
  }
}

/** The sockets of one worker and how they open, receive, drain and close. */
export interface SocketServer {
  /** Serves the upgrade requests of `ws.ts` endpoints. */
  run: SocketRunner;
  /** Bun's WebSocket handler. */
  handler: Bun.WebSocketHandler<SocketData>;
  /** The sockets open now. */
  readonly open: ReadonlySet<OpenSocket>;
  /** Closes every open socket with a code and a reason. */
  closeAll(code: number, reason: string): void;
  /** Publishing, disconnecting and counting for any code of the worker. */
  readonly sockets: Sockets;
  /** This process's id in envelopes. */
  readonly origin: string;
  /** Starts delivering through a transport: envelopes from other processes reach this worker's sockets. */
  startTransport(transport: SocketTransport): Promise<void>;
  /** Stops the transport. */
  stopTransport(): Promise<void>;
}

type Handler = (ws: Socket, value: never, ctx: SocketContext) => unknown;

/** A frame ready for its handler, with the id it carries; or the error frame answering it. */
export type DecodedFrame = { handler: Handler; value: unknown; id?: string | number } | { error: { code: string; message: string; details?: unknown }; id?: undefined };

const invalid = (message: string, details?: unknown): DecodedFrame => ({ error: { code: "INVALID_MESSAGE", message, ...(details ? { details } : {}) } });

/**
 * Decodes a frame of a socket with message types: one JSON parse and one validator call, routed by its `type` to `on`
 * (else to `message`); an unknown type with no `message` fallback, invalid JSON, a binary frame or a value that does
 * not match `in` answer an error frame.
 */
export function decodeFrame(data: string | Uint8Array, definition: SocketDefinition): DecodedFrame {
  if (typeof data !== "string") return invalid("Binary messages are not accepted");
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return invalid("Message is not valid JSON");
  }
  const { handlers, messages } = definition;
  const type = typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" ? (value as { type: string }).type : undefined;
  const routed = type !== undefined ? handlers.on?.[type] : undefined;
  const rawId = typeof value === "object" && value !== null ? (value as { id?: unknown }).id : undefined;
  const id = typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined;
  // A type no member of the union declares goes to the fallback, or is refused as unknown.
  const known = type === undefined || (messages?.byType ? messages.byType.has(type) : routed !== undefined || handlers.on === undefined);
  if (!known || (routed === undefined && handlers.message === undefined)) {
    if (handlers.message !== undefined && type !== undefined && !known) return { handler: handlers.message as Handler, value, ...(id !== undefined ? { id } : {}) };
    return { error: { code: "UNKNOWN_MESSAGE_TYPE", message: `Unknown message type ${type ?? "(none)"}` } };
  }
  const validate = type !== undefined && messages?.byType?.get(type);
  const issues = validate ? validate(value) : messages?.validate(value);
  if (issues) return invalid("Message does not match the expected shape", issues);
  return { handler: (routed ?? handlers.message) as Handler, value, ...(id !== undefined ? { id } : {}) };
}

/** The text of an error, for logs. */
const errorOf = (error: unknown) => ({ message: (error as Error)?.message ?? String(error), ...(error instanceof Error ? { stack: error.stack } : {}) });

export function socketServer(settings: SocketSettings): SocketServer {
  const open = new Set<OpenSocket>();
  const hooks: SocketHooks = { ...NO_HOOKS, ...settings.hooks };
  const defaults: SocketLimits = { maxMessageSize: settings.maxMessageSize, messages: settings.messages };
  /** Runs the `beforePublish` hooks, then publishes the data (or nothing when a hook returns null). */
  const publishing = (room: string, data: unknown, ws: Socket | undefined, send: (data: unknown) => void) => {
    if (hooks.beforePublish.length === 0) return send(data);
    void (async () => {
      let current = data;
      for (const fn of hooks.beforePublish) {
        const result = await fn(ws ? { room, data: current, ws } : { room, data: current }, undefined);
        if (result === null) return;
        if (result !== undefined) current = isStep(result, ["room", "data"]) ? (result as { data: unknown }).data : result;
      }
      send(current);
    })().catch((error: unknown) => safeLog(settings.logger, "error", { timestamp: new Date().toISOString(), message: "feature.hook.failed", feature: "realtime", hook: "websockets.beforePublish", error: errorOf(error) }));
  };
  /** The Bun server that accepted the sockets, known from the first upgrade. */
  let bunServer: BunPublisher | undefined;
  const rooms: RoomContext = {
    // With tenancy, every room lives in its tenant's namespace (`-:` without a tenant), so tenants never share one.
    topicOf: settings.tenantRooms ? (room, tenant) => `${tenant ?? "-"}:${room}` : (room) => room,
    maxRooms: settings.maxRooms,
    publishFrom(socket, room, topic, data) {
      publishing(room, data, socket, (value) => {
        const frame = encodeFrame(value);
        socket.ws?.publish(topic, frame);
        toTransport("publish", (current) => current.publish({ origin, room: topic, ...encodeEnvelopeData(frame), except: socket.id }));
      });
    },
    mayJoin(socket, room) {
      for (const fn of hooks.beforeSubscribe) {
        const result = fn({ ws: socket, room }, undefined);
        if (result instanceof Promise) throw new Error("beforeSubscribe hooks must return synchronously");
        if (result === false) return false;
      }
      return true;
    },
  };
  /** The tenant a publish from code is for: the option, else the tenant whose scope the code runs in. */
  const tenantOf = (options: PublishOptions | { tenant?: string } | undefined) => options?.tenant ?? currentTenant()?.id;
  const ownOrigin = ownOriginReader(settings.proxy);
  const fixed = Array.isArray(settings.origins) ? new OriginMatcher(settings.origins) : undefined;
  const computed = typeof settings.origins === "function" ? settings.origins : undefined;

  const originAllowed = async (req: ServiceRequest, header: string, routeOrigins?: readonly string[] | OptionFunction<string[]>) => {
    const origin = normalizeOrigin(header);
    if (origin === undefined) return false;
    if (origin === ownOrigin(req)) return true;
    // A route's @socket origins replace the global ones for it.
    if (routeOrigins !== undefined) {
      const list = typeof routeOrigins === "function" ? ((await resolveOption(routeOrigins, { req })) ?? []) : routeOrigins;
      return new OriginMatcher(list).allows(origin);
    }
    if (fixed?.allows(origin)) return true;
    if (!computed) return false;
    return new OriginMatcher((await resolveOption(computed, { req })) ?? []).allows(origin);
  };

  const failed = (socket: OpenSocket, handler: string, error: unknown) =>
    safeLog(settings.logger, "error", { timestamp: new Date().toISOString(), message: "realtime.socket.failed", route: socket.route, socketId: socket.id, handler, error: errorOf(error) });

  /** Runs a handler in the tenant's database scope when tenancy is on, so `ctx.repos` are the tenant's for the call. */
  const call = async <T>(socket: OpenSocket, fn: (ctx: SocketContext) => T | Promise<T>): Promise<T> => {
    const tenant = (socket.ctx.tenant as { id?: string } | undefined)?.id;
    if (tenant === undefined || !tenantRuns()) return fn(socket.ctx);
    return runForTenant(tenant, ({ repos }) => fn({ ...socket.ctx, repos: repos as unknown as Repositories }));
  };

  const run: SocketRunner = async (definition, repos, req) => {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      throw new HttpError(426, "This route needs a WebSocket connection", { code: "UPGRADE_REQUIRED", headers: { upgrade: "websocket" } });
    }
    const limits = settings.limitsFor ? await settings.limitsFor(req) : defaults;
    const origin = req.headers.get("origin");
    if (origin !== null && !(await originAllowed(req, origin, limits.origins))) throw new HttpError(403, "Origin not allowed");
    if (open.size >= settings.maxConnections) throw new HttpError(503, "Too many open sockets", { headers: { "retry-after": "5" } });
    for (const fn of hooks.beforeConnect) await fn({ req, user: req.user, tenant: req.tenant, route: req.route }, undefined);
    const ctx: SocketContext = { params: req.params, query: req.query, user: req.user, tenant: req.tenant, repos, log: settings.logger, req };
    const socket = new OpenSocket(definition, ctx, req.route, req.id, rooms, req.auth?.sessionId, limits);
    bunServer ??= bunServerOf(req.raw);
    if (!upgradeRequest(req.raw, { socket } satisfies SocketData)) throw new HttpError(400, "Invalid WebSocket upgrade");
    // The server answers the upgraded request itself; this response is never sent.
    return new Response(null, { status: 200 });
  };

  const handler: Bun.WebSocketHandler<SocketData> = {
    // Bun ends a connection with a frame over its limit without a close code, so its limit is twice the native's,
    // which closes larger frames with 1009 itself.
    maxPayloadLength: settings.maxMessageSize * 2,
    idleTimeout: settings.idleTimeout,
    sendPings: true,
    async open(ws) {
      const socket = ws.data.socket;
      socket.ws = ws as unknown as BunSocket;
      open.add(socket);
      const { open: onOpen } = socket.definition.handlers;
      if (onOpen) {
        try {
          await call(socket, (ctx) => onOpen(socket, ctx));
        } catch (error) {
          failed(socket, "open", error);
          socket.close(CLOSE_CODES.internal, "Internal error");
          return;
        }
      }
      if (hooks.afterConnect.length > 0) await runAfterHooks(hooks.afterConnect, { ws: socket }, undefined);
    },
    async message(ws, message) {
      const socket = ws.data.socket;
      socket.messagesIn += 1;
      const now = performance.now();
      const { limits } = socket;
      if (now - socket.windowStart >= limits.messages.windowMs) {
        socket.windowStart = now;
        socket.windowCount = 0;
      }
      socket.windowCount += 1;
      if (socket.windowCount > limits.messages.count) {
        socket.close(CLOSE_CODES.policy, "Too many messages");
        return;
      }
      const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
      if (size > limits.maxMessageSize) {
        socket.close(CLOSE_CODES.tooBig, "Message too big");
        return;
      }
      let data: string | Uint8Array = typeof message === "string" ? message : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      if (hooks.beforeMessage.length > 0) {
        try {
          for (const fn of hooks.beforeMessage) {
            const result = await fn({ ws: socket, data }, undefined);
            if (result === null) return;
            if (result !== undefined) data = (isStep(result, ["ws", "data"]) ? (result as { data: unknown }).data : result) as string | Uint8Array;
          }
        } catch (error) {
          failed(socket, "beforeMessage", error);
          socket.close(CLOSE_CODES.internal, "Internal error");
          return;
        }
      }
      const { handlers } = socket.definition;
      const typed = socket.definition.messages !== undefined || handlers.on !== undefined;
      let decoded: DecodedFrame;
      if (!typed) decoded = { handler: handlers.message as Handler, value: data };
      else {
        decoded = decodeFrame(data, socket.definition);
        if ("error" in decoded) {
          socket.send({ error: decoded.error });
          return;
        }
      }
      const ready = decoded as { handler: Handler; value: unknown; id?: string | number };
      const id = ready.id;
      try {
        const result = await call(socket, (ctx) => ready.handler(socket, ready.value as never, ctx));
        if (id !== undefined && result !== undefined) socket.send({ id, result });
      } catch (error) {
        if (error instanceof HttpError) {
          const body = { code: error.code, message: error.responseMessage ?? error.message };
          socket.send(id !== undefined ? { id, error: body } : { error: body });
          return;
        }
        failed(socket, "message", error);
        socket.close(CLOSE_CODES.internal, "Internal error");
      }
    },
    async drain(ws) {
      const socket = ws.data.socket;
      const { drain } = socket.definition.handlers;
      if (!drain) return;
      try {
        await call(socket, (ctx) => drain(socket, ctx));
      } catch (error) {
        failed(socket, "drain", error);
      }
    },
    async close(ws, code, reason) {
      const socket = ws.data.socket;
      open.delete(socket);
      const closeCode = socket.closeCode ?? code;
      safeLog(settings.logger, "info", {
        [REQUEST_LOG]: true,
        timestamp: new Date().toISOString(),
        requestId: socket.requestId,
        method: "GET",
        route: socket.route,
        status: 101,
        durationMs: Math.round((performance.now() - socket.openedAt) * 1000) / 1000,
        socketId: socket.id,
        messagesIn: socket.messagesIn,
        messagesOut: socket.messagesOut,
        closeCode,
      });
      const { close } = socket.definition.handlers;
      if (close) {
        try {
          await call(socket, (ctx) => close(socket, closeCode, reason, ctx));
        } catch (error) {
          failed(socket, "close", error);
        }
      }
      if (hooks.onClose.length > 0) await runAfterHooks(hooks.onClose, { ws: socket, code: closeCode, reason, durationMs: Math.round(performance.now() - socket.openedAt) }, undefined);
    },
  };

  const origin = transportOrigin();
  let transport: SocketTransport | undefined;
  const transportFailed = (operation: string, error: unknown) =>
    safeLog(settings.logger, "error", { timestamp: new Date().toISOString(), message: "realtime.transport.failed", operation, error: errorOf(error) });
  /** Hands work to the transport; a failure is logged and never fails the local delivery. */
  const toTransport = (operation: string, work: (current: SocketTransport) => void | Promise<void>) => {
    const current = transport;
    if (!current) return;
    try {
      const pending = work(current);
      if (pending instanceof Promise) pending.catch((error: unknown) => transportFailed(operation, error));
    } catch (error) {
      transportFailed(operation, error);
    }
  };
  /** Publishes a frame to this worker's sockets of a topic, minus the socket `except`. */
  const deliver = (topic: string, frame: string | Uint8Array, except: string | undefined) => {
    const skipped = except !== undefined ? [...open].find((socket) => socket.id === except && socket.ws?.isSubscribed(topic)) : undefined;
    // A socket's own publish reaches the room's other sockets; Bun's publish reaches all of them.
    if (skipped?.ws) skipped.ws.publish(topic, frame);
    else bunServer?.publish(topic, frame);
  };
  const disconnectLocal = (filter: DisconnectFilter) => {
    let count = 0;
    for (const socket of [...open]) {
      if (!matches(socket, filter)) continue;
      socket.close(filter.code ?? 4001, filter.reason ?? "Disconnected");
      count += 1;
    }
    return count;
  };

  const matches = (socket: OpenSocket, filter: DisconnectFilter) =>
    (filter.user === undefined || (socket.user as { id?: string } | undefined)?.id === filter.user) &&
    (filter.sessionId === undefined || socket.sessionId === filter.sessionId) &&
    (filter.tenant === undefined || socket.tenantId === filter.tenant) &&
    (filter.room === undefined || socket.joined.has(filter.room));

  const sockets: Sockets = {
    publish(room, data, options) {
      assertRoomName(room);
      const topic = rooms.topicOf(room, tenantOf(options));
      publishing(room, data, undefined, (value) => {
        const frame = encodeFrame(value);
        deliver(topic, frame, options?.except);
        toTransport("publish", (current) => current.publish({ origin, room: topic, ...encodeEnvelopeData(frame), ...(options?.except !== undefined ? { except: options.except } : {}) }));
      });
    },
    disconnect(filter) {
      const count = disconnectLocal(filter);
      toTransport("disconnect", (current) => current.disconnect({ ...filter, origin }));
      return count;
    },
    count(room, options) {
      assertRoomName(room);
      const tenant = settings.tenantRooms ? tenantOf(options) : undefined;
      let count = 0;
      for (const socket of open) if (socket.joined.has(room) && (!settings.tenantRooms || socket.tenantId === tenant)) count += 1;
      return count;
    },
  };

  return {
    run,
    handler,
    open,
    sockets,
    origin,
    async startTransport(next) {
      await next.start({
        onMessage(envelope: SocketEnvelope) {
          if (envelope.origin === origin) return;
          deliver(envelope.room, decodeEnvelopeData(envelope), envelope.except);
        },
        onDisconnect(filter) {
          if (filter.origin === origin) return;
          const { origin: _origin, ...rest } = filter;
          disconnectLocal(rest);
        },
        logger: settings.logger,
      });
      transport = next;
    },
    async stopTransport() {
      const current = transport;
      transport = undefined;
      if (!current) return;
      try {
        await current.stop();
      } catch (error) {
        transportFailed("stop", error);
      }
    },
    closeAll(code, reason) {
      for (const socket of [...open]) socket.close(code, reason);
    },
  };
}
