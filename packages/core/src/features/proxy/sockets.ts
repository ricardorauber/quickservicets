import { endUpgradedRequest, HttpError, REQUEST_LOG, runAfterHooks, safeLog, type ForeignConnection, type ForeignSocket, type ForeignSockets, type ServiceRequest } from "../public.ts";
import { prepareUpstream, type ForwardContext, type ProxyRoute } from "./forward.ts";

/** The close codes a proxied socket uses besides the ones it passes on. */
const CLOSE = { normal: 1000, goingAway: 1001, tooBig: 1009, badGateway: 1014 } as const;

/** The close codes a peer reports but no endpoint may send. */
const UNSENDABLE = new Set([1005, 1006, 1015]);

/** The headers of the client's handshake the upstream handshake makes its own. */
const HANDSHAKE_HEADERS = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", "content-length"];

/** Whether a request asks to become a WebSocket. */
export const isUpgrade = (req: ServiceRequest) => req.method === "GET" && (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

/** The byte size of a frame. */
const sizeOf = (data: string | ArrayBuffer | Uint8Array) => (typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);

/** The frame as the other side sends it: text stays text, and binary becomes bytes. */
const frameOf = (data: unknown): string | Uint8Array => (typeof data === "string" ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array));

/**
 * Proxies an upgrade request to the route's upstream as a WebSocket: the route's checks, the realtime origin and
 * connection checks and `beforeProxy` run first, the upstream handshake must succeed (502 when refused or unreachable,
 * 504 past the route's timeout) before the client is upgraded with the upstream's subprotocol, and then frames are
 * piped both ways with the size and idle limits of `realtime.websockets`, closes passed on, and one request log entry
 * written when the pair closes.
 */
export async function proxySocket(req: ServiceRequest, route: ProxyRoute, context: ForwardContext, sockets: ForeignSockets, extraHeaders?: Readonly<Record<string, string>>): Promise<Response> {
  route.authorize?.(req);
  await sockets.admit(req);
  const { url, headers } = await prepareUpstream(req, route, context, extraHeaders);
  for (const name of HANDSHAKE_HEADERS) headers.delete(name);
  const target = new URL(url);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const upstream = await openUpstream(req, route, context, target.href, headers, offered);
  const pair = new ProxiedPair(req, route, upstream.socket, upstream.early, sockets, context);
  const chosen = upstream.socket.protocol;
  if (!sockets.upgrade(req, pair, chosen ? { "sec-websocket-protocol": chosen } : undefined)) {
    upstream.socket.close(CLOSE.goingAway);
    throw new HttpError(400, "Invalid WebSocket upgrade");
  }
  // The server answers the upgraded request itself; this response is never sent.
  return new Response(null, { status: 101 });
}

/** Opens the upstream WebSocket, resolving once its handshake succeeded with the frames it sent before the client is ready. */
function openUpstream(req: ServiceRequest, route: ProxyRoute, context: ForwardContext, url: string, headers: Headers, protocols: string[]): Promise<{ socket: WebSocket; early: (string | Uint8Array)[] }> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { headers: Object.fromEntries(headers), ...(protocols.length > 0 ? { protocols } : {}) } as never);
    } catch (error) {
      void fail(error, new HttpError(502, "Upstream request failed", { code: "BAD_GATEWAY" }));
      return;
    }
    socket.binaryType = "arraybuffer";
    const early: (string | Uint8Array)[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      try {
        socket.close();
      } catch {}
      void fail(new Error(`WebSocket handshake with ${url} timed out`), new HttpError(504, "Upstream request timed out", { code: "GATEWAY_TIMEOUT" }));
    }, route.timeoutMs);
    socket.onmessage = (event) => void early.push(frameOf(event.data));
    socket.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ socket, early });
    };
    const refused = (event: Event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const reason = (event as CloseEvent).reason || (event as ErrorEvent).message || "WebSocket handshake failed";
      void fail(new Error(reason), new HttpError(502, "Upstream request failed", { code: "BAD_GATEWAY" }));
    };
    socket.onerror = refused;
    socket.onclose = refused;
    async function fail(error: unknown, answer: HttpError) {
      if (context.onProxyError.length > 0) await runAfterHooks(context.onProxyError, { req, route: route.name, error }, undefined).catch(() => undefined);
      reject(answer);
    }
  });
}

/** A client socket and its upstream socket, piping frames and closes between them. */
class ProxiedPair implements ForeignConnection {
  client: ForeignSocket | undefined;
  messagesIn = 0;
  messagesOut = 0;
  readonly openedAt = performance.now();
  lastFrame = performance.now();
  closeCode: number | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  upstreamClosed = false;
  ended = false;

  constructor(
    readonly req: ServiceRequest,
    readonly route: ProxyRoute,
    readonly upstream: WebSocket,
    private early: (string | Uint8Array)[],
    readonly sockets: ForeignSockets,
    readonly context: ForwardContext,
  ) {
    upstream.onmessage = (event) => this.fromUpstream(frameOf(event.data));
    upstream.onclose = (event) => this.upstreamClosedWith(event.code, event.reason);
    upstream.onerror = () => this.upstreamClosedWith(1006, "");
  }

  open(ws: ForeignSocket): void {
    this.client = ws;
    const queued = this.early;
    this.early = [];
    for (const frame of queued) this.fromUpstream(frame);
    if (this.upstream.readyState !== WebSocket.OPEN && !this.upstreamClosed) return;
    if (this.upstreamClosed) return this.closeClient(CLOSE.badGateway, "Bad gateway");
    this.armIdle();
  }

  /** Closes both sockets after `idleTimeout` without frames in either direction. */
  armIdle(): void {
    if (this.ended) return;
    const idleMs = this.sockets.idleTimeoutMs;
    const left = this.lastFrame + idleMs - performance.now();
    this.idleTimer = setTimeout(() => {
      if (performance.now() - this.lastFrame >= idleMs - 5) this.closeBoth(CLOSE.goingAway, "Idle timeout");
      else this.armIdle();
    }, Math.max(left, 10));
  }

  message(_ws: ForeignSocket, data: string | Uint8Array): void {
    if (sizeOf(data) > this.sockets.maxMessageSize) return this.closeBoth(CLOSE.tooBig, "Message too big");
    this.messagesIn += 1;
    this.lastFrame = performance.now();
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(data);
  }

  fromUpstream(frame: string | Uint8Array): void {
    if (!this.client) return void this.early.push(frame);
    if (sizeOf(frame) > this.sockets.maxMessageSize) return this.closeBoth(CLOSE.tooBig, "Message too big");
    this.messagesOut += 1;
    this.lastFrame = performance.now();
    this.client.send(frame);
  }

  /** The upstream closed: its code and reason reach the client, or 1014 when it dropped the connection or failed. */
  upstreamClosedWith(code: number, reason: string): void {
    if (this.upstreamClosed) return;
    this.upstreamClosed = true;
    if (!this.client) return;
    if (code === 1005) this.closeClient(CLOSE.normal, reason);
    else if (UNSENDABLE.has(code)) this.closeClient(CLOSE.badGateway, "Bad gateway");
    else this.closeClient(code, reason);
  }

  closeClient(code: number, reason: string): void {
    this.closeCode ??= code;
    this.client?.close(code, reason);
  }

  closeUpstream(code: number, reason?: string): void {
    if (this.upstreamClosed) return;
    this.upstreamClosed = true;
    try {
      this.upstream.close(code, reason);
    } catch {
      this.upstream.close();
    }
  }

  closeBoth(code: number, reason: string): void {
    this.closeUpstream(code, reason);
    this.closeClient(code, reason);
  }

  shutdown(code: number, reason: string): void {
    this.closeBoth(code, reason);
  }

  /** The client closed: its code and reason reach the upstream, or 1001 when it dropped; the request log entry is written. */
  close(_ws: ForeignSocket, code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    if (code === 1005) this.closeUpstream(CLOSE.normal, reason);
    else if (UNSENDABLE.has(code)) this.closeUpstream(CLOSE.goingAway, "Client went away");
    else this.closeUpstream(code, reason);
    const closeCode = this.closeCode ?? code;
    endUpgradedRequest(this.req.raw, closeCode);
    safeLog(this.context.logger, "info", {
      [REQUEST_LOG]: true,
      timestamp: new Date().toISOString(),
      requestId: this.req.id,
      method: "GET",
      route: this.req.route,
      status: 101,
      proxy: this.route.name ?? "forward",
      durationMs: Math.round((performance.now() - this.openedAt) * 1000) / 1000,
      messagesIn: this.messagesIn,
      messagesOut: this.messagesOut,
      closeCode,
    });
  }
}
