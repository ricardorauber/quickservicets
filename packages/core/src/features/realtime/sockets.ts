import {
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
  type Logger,
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

  constructor(
    readonly definition: SocketDefinition,
    readonly ctx: SocketContext,
    readonly route: string,
    readonly requestId: string,
  ) {}

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
    if (typeof data === "string" || data instanceof Uint8Array) this.ws.send(data);
    else this.ws.send(JSON.stringify(data));
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
  const ownOrigin = ownOriginReader(settings.proxy);
  const fixed = Array.isArray(settings.origins) ? new OriginMatcher(settings.origins) : undefined;
  const computed = typeof settings.origins === "function" ? settings.origins : undefined;

  const originAllowed = async (req: ServiceRequest, header: string) => {
    const origin = normalizeOrigin(header);
    if (origin === undefined) return false;
    if (origin === ownOrigin(req) || fixed?.allows(origin)) return true;
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
    const origin = req.headers.get("origin");
    if (origin !== null && !(await originAllowed(req, origin))) throw new HttpError(403, "Origin not allowed");
    if (open.size >= settings.maxConnections) throw new HttpError(503, "Too many open sockets", { headers: { "retry-after": "5" } });
    const ctx: SocketContext = { params: req.params, query: req.query, user: req.user, tenant: req.tenant, repos, log: settings.logger, req };
    const socket = new OpenSocket(definition, ctx, req.route, req.id);
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
      if (!onOpen) return;
      try {
        await call(socket, (ctx) => onOpen(socket, ctx));
      } catch (error) {
        failed(socket, "open", error);
        socket.close(CLOSE_CODES.internal, "Internal error");
      }
    },
    async message(ws, message) {
      const socket = ws.data.socket;
      socket.messagesIn += 1;
      const now = performance.now();
      if (now - socket.windowStart >= settings.messages.windowMs) {
        socket.windowStart = now;
        socket.windowCount = 0;
      }
      socket.windowCount += 1;
      if (socket.windowCount > settings.messages.count) {
        socket.close(CLOSE_CODES.policy, "Too many messages");
        return;
      }
      const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
      if (size > settings.maxMessageSize) {
        socket.close(CLOSE_CODES.tooBig, "Message too big");
        return;
      }
      const data = typeof message === "string" ? message : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
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
      if (!close) return;
      try {
        await call(socket, (ctx) => close(socket, closeCode, reason, ctx));
      } catch (error) {
        failed(socket, "close", error);
      }
    },
  };

  return {
    run,
    handler,
    open,
    closeAll(code, reason) {
      for (const socket of [...open]) socket.close(code, reason);
    },
  };
}
