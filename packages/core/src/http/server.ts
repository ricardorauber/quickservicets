import { HttpError, toErrorResponse } from "../errors.ts";
import type { Repositories, RequestExtensions, ServiceRequest, ServiceResponse } from "../hooks.ts";
import { noRequestJobs, type RequestJobs } from "../jobs/triggers.ts";
import { jsonLogger, REQUEST_LOG, safeLog, type LogMasker, type Logger } from "../logger.ts";
import { executedHooks } from "./pipeline.ts";
import { composeHandlerStage, composeRequestStage, type MiddlewareStages } from "../middleware.ts";
import { Router } from "./router.ts";
import { normalizeAddress } from "../cidr.ts";
import type { FileHeaders } from "../files/access.ts";
import { readBodyText } from "./body.ts";
import type { RepositoryResolver } from "../repository-resolver.ts";
import type { TenantRuns } from "../tenant-runs.ts";
import type { SocketRunner } from "./socket.ts";
import { bunTlsOptions, loadServerTls, type ServerTlsConfig } from "../tls.ts";
import { listenWithClientCertificates } from "./tls-server.ts";
import { requestTlsRestart, TlsReloader, type ReloadedTls } from "../tls-reload.ts";
import { clientCertificateOf } from "../client-certificates.ts";
import { notifyRequestObservers, requestsObserved } from "../request-observers.ts";
import { coreInstruments, metricsEnabled, tenantAttributes, type MeterSetting, type MetricAttributes } from "../metering.ts";
import { parseTraceparent, spanAttributes, startSpan, tracingEnabled, withSpan, type Span, type TracerSetting } from "../tracing.ts";

export type HandlerResult<Result> = Result | Response | undefined;

/** An endpoint handler: receives the repositories, the request and the response controls. */
export type Endpoint<Body = unknown, Result = unknown> = (
  repos: Repositories,
  req: ServiceRequest<Body>,
  res: ServiceResponse,
) => HandlerResult<Result> | Promise<HandlerResult<Result>>;

export interface Route {
  method: string;
  /** Route path with dynamic segments in brackets, e.g. `/users/[id]`. */
  path: string;
  handler: Endpoint;
  /** Status of a success response when the handler does not set one with `res.status`. */
  status?: number;
  /** `false` leaves the route's requests out of the request log, except for 5xx responses. */
  log?: boolean;
}

/** Settings features give the HTTP server during setup, with `ctx.app.configureServer`. */
export interface ServerSettings {
  /** Computes `req.ip` from the request and its peer address, when `req.ip` is first read (default: the peer address). */
  clientIp?: (request: Request, peer: string) => string;
  /** Headers added to (or replacing those of) the responses of the file routes in `proxy` and `signed` modes. */
  fileHeaders?: FileHeaders;
  /** The largest body the socket accepts, in bytes (default: Bun's); larger bodies are refused before any code runs. */
  maxRequestBodySize?: number;
  /** Seconds a connection may stay idle before the socket closes it, 0 for never (default: Bun's). */
  idleTimeout?: number;
  /** Masks what the service logs, stores in job runs and shows in development error responses. */
  mask?: LogMasker;
  /** Computes entity tags for `res.etag`; without it `res.etag` throws. */
  entityTags?: EntityTags;
  /**
   * Chooses the repositories each request's hooks and handler receive, right before they run (after the handler
   * middlewares); set with `setRepositoryResolver` during setup. Without it, every request gets `repos`.
   */
  repositories?: RepositoryResolver;
  /** Set by `enableDatabaseScopes()` during setup: the core's database functions follow the current database scope. */
  databaseScopes?: boolean;
  /** Set by `setTenantRuns()` during setup: how jobs, consumers and listeners run for a tenant. */
  tenantRuns?: TenantRuns;
  /** Adds `tenant: <id>` to the request log entry of every request with `req.tenant`. */
  requestLogTenant?: boolean;
  /** Wraps the service's logger (after masking), like adding the current tenant to every entry. */
  wrapLogger?: (logger: Logger) => Logger;
  /** Bun's WebSocket handler, passed to `Bun.serve` only when set (the `realtime` native sets it for `ws.ts` routes). */
  websocket?: Bun.WebSocketHandler<unknown>;
  /** What serves the upgrade requests of this service's `ws.ts` endpoints. */
  socketRunner?: SocketRunner;
  /** Set by `setTracer()` during setup: the tracer of the service and the feature that set it. */
  tracer?: TracerSetting;
  /** Set by `setMeter()` during setup: the meter of the service, the feature that set it and its options. */
  meter?: MeterSetting;
  /**
   * Asks callers for client certificates checked against `ca` (`required` refuses the handshake without one); the
   * server then listens through `node:tls`, which gives each request its verified certificate as `req.client`.
   */
  clientCertificates?: { ca: string[]; required: boolean; sources?: string[] };
}

export interface ServerOptions extends ServerSettings {
  routes: Route[];
  repos: Repositories;
  config: { production: boolean; server?: { port: number; workers?: number; tls?: ServerTlsConfig }; logger?: Logger };
  /** `req.jobs` of every request (default: no jobs). */
  jobs?: RequestJobs;
  /** The middlewares of each stage, in the order they run (default: none). */
  middleware?: MiddlewareStages;
  /** Properties computed on first read of each request, by name. */
  requestProperties?: ReadonlyMap<string, (req: ServiceRequest) => unknown>;
}

/** What `server.fetch` takes besides the request. */
export interface FetchOptions {
  /** The address of the client socket, as tests give it; a request without one has the peer `unknown`. */
  peer?: string;
}

export interface Server {
  fetch(request: Request, options?: FetchOptions): Promise<Response>;
  listen(port?: number): ReturnType<typeof Bun.serve>;
}

/** Computes entity tags for `res.etag` and matches them against a request's `If-None-Match`; the `etag` native gives it. */
export interface EntityTags {
  /** The strong tag of a record. */
  tag(record: object): string;
  /** Whether an `If-None-Match` value lists the tag (weak comparison, `*` included). */
  noneMatch(header: string | null, tag: string): boolean;
}

class ResponseControls implements ServiceResponse {
  statusCode: number | undefined;
  readonly headers = new Headers();
  /** The status of a success response when the handler sets none: the route's `@status`. */
  defaultStatus: number | undefined;
  /** Set when `res.etag` matched the request's `If-None-Match`: the response is a 304 without a body. */
  notModified = false;

  constructor(
    private readonly request?: Request,
    private readonly tags?: EntityTags,
  ) {}

  etag(value: object | string): ServiceResponse {
    if (!this.tags) throw new Error("etag is not enabled; add etag: {} to quickservicets.config.ts");
    const tag = typeof value === "string" ? (/^(W\/)?".*"$/.test(value) ? value : `"${value}"`) : this.tags.tag(value);
    this.headers.set("etag", tag);
    if (this.request && this.tags.noneMatch(this.request.headers.get("if-none-match"), tag)) this.notModified = true;
    return this;
  }

  status(code: number): ServiceResponse {
    this.statusCode = code;
    return this;
  }

  header(name: string, value: string): ServiceResponse {
    this.headers.set(name, value);
    return this;
  }
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function requestIdOf(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header !== null && REQUEST_ID.test(header) ? header : Bun.randomUUIDv7();
}

function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
}

/** Responses whose request log entry waits for their body to end, with the fields it adds. */
const deferredLogs = new WeakMap<Response, Promise<Record<string, unknown>>>();

/**
 * Writes the request log entry of a streaming response when `finished` resolves, with its fields added and the
 * duration up to then, instead of when the response starts.
 */
export function deferRequestLog(response: Response, finished: Promise<Record<string, unknown>>): void {
  deferredLogs.set(response, finished);
}

/** The Bun server that accepted each request, for upgrading it to a WebSocket. */
const servers = new WeakMap<Request, BunServer>();

/** The part of a Bun server the core uses for WebSockets. */
export interface BunServer {
  upgrade(request: Request, options?: { data?: unknown; headers?: Record<string, string> }): boolean;
  /** Sends to every socket subscribed to the topic; resolves the bytes sent. */
  publish(topic: string, data: string | Uint8Array): number;
}

/** The Bun server that accepted a request, while it serves WebSockets; undefined for a request built in a test. */
export function bunServerOf(request: Request): BunServer | undefined {
  return servers.get(request);
}
/** The requests upgraded to a WebSocket: the server answers them with nothing, and writes no request log entry for them. */
const upgraded = new WeakSet<Request>();

/** What ends an upgraded request once its socket closes: the server span and what else waits for the request's end. */
const upgradeEnds = new WeakMap<Request, (closeCode: number) => void>();

/** The server span of each traced request, while tracing is enabled. */
const requestSpans = new WeakMap<Request, Span>();

/** The server span of a request, while a tracer is set; undefined otherwise. */
export function requestSpanOf(request: Request): Span | undefined {
  return requestSpans.get(request);
}

/**
 * Ends a request upgraded to a WebSocket when its socket closes, with the close code: its server span ends with a
 * `websocket.closed` event. The socket server calls it; a request without anything waiting for its end is ignored.
 */
export function endUpgradedRequest(request: Request, closeCode: number): void {
  const end = upgradeEnds.get(request);
  if (!end) return;
  upgradeEnds.delete(request);
  end(closeCode);
}

/**
 * Upgrades a request to a WebSocket through the Bun server that accepted it, with `data` for the socket's handlers;
 * false for a request no server accepted (like one built in a test) or that Bun cannot upgrade.
 */
export function upgradeRequest(request: Request, data: unknown, headers?: Record<string, string>): boolean {
  const server = servers.get(request);
  if (!server) return false;
  const done = server.upgrade(request, { data, ...(headers ? { headers } : {}) });
  if (done) upgraded.add(request);
  return done;
}

/** Where the peer address of each request comes from: the address itself, or the Bun server that accepted it. */
const peers = new WeakMap<Request, string | { requestIP(request: Request): { address: string } | null }>();

/**
 * The address of the socket a request came from, normalized (`::ffff:203.0.113.5` reads `203.0.113.5`), or `unknown`
 * for a request without one, like a request built in a test without the `peer` option.
 */
export function peerAddress(request: Request): string {
  const source = peers.get(request);
  if (source === undefined) return "unknown";
  if (typeof source === "string") return source;
  const address = source.requestIP(request)?.address;
  const peer = address === undefined ? "unknown" : (normalizeAddress(address) ?? address);
  peers.set(request, peer);
  return peer;
}

function createRequest(raw: Request, url: URL, params: Record<string, string>, id: string, jobs: RequestJobs, route: string, clientIp: ServerSettings["clientIp"]): ServiceRequest {
  let body: Promise<unknown> | undefined;
  // The properties of `RequestExtensions` are added by the enabled features' request factories.
  const request: Omit<ServiceRequest, keyof RequestExtensions> = {
    get ip() {
      const value = clientIp ? clientIp(raw, peerAddress(raw)) : peerAddress(raw);
      Object.defineProperty(this, "ip", { value, configurable: true, enumerable: true, writable: true });
      return value;
    },
    get client() {
      const value = clientCertificateOf(raw);
      Object.defineProperty(this, "client", { value, configurable: true, enumerable: true, writable: true });
      return value;
    },
    id,
    route,
    user: undefined,
    tenant: undefined,
    flags: undefined,
    method: raw.method,
    path: url.pathname,
    params,
    query: url.searchParams,
    headers: raw.headers,
    raw,
    context: {},
    queryItems: {},
    jobs,
    json() {
      body ??= readBodyText(raw).then((text) => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new HttpError(400, "Invalid JSON body");
        }
      });
      return body;
    },
  };
  return request as ServiceRequest;
}

/** The response for a handler's result; `status` replaces the default 200 (or 204 for `undefined`) when `res.status` was not called. */
export function toResponse(result: unknown, res: ResponseControls, status?: number): Response {
  if (result instanceof Response) return result;
  if (res.notModified) return new Response(null, { status: 304, headers: res.headers });
  if (result === undefined) {
    return new Response(null, { status: res.statusCode ?? status ?? 204, headers: res.headers });
  }
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(result), { status: res.statusCode ?? status ?? 200, headers });
}

/** Defines each request property as a getter that computes its value on first read and keeps it for the request. */
function withRequestProperties(req: ServiceRequest, properties: ReadonlyMap<string, (req: ServiceRequest) => unknown>): ServiceRequest {
  for (const [name, factory] of properties) {
    Object.defineProperty(req, name, {
      configurable: true,
      enumerable: false,
      get() {
        const value = factory(req);
        Object.defineProperty(req, name, { value, configurable: true, enumerable: false, writable: true });
        return value;
      },
    });
  }
  return req;
}

/** Starts the server span of a request, continuing the trace of a valid `traceparent` header. */
function serverSpan(request: Request, requestId: string): Span {
  const url = new URL(request.url);
  const parent = parseTraceparent(request.headers.get("traceparent"), request.headers.get("tracestate")) ?? null;
  const scheme = url.protocol.replace(/:$/, "");
  const span = startSpan(request.method, {
    kind: "server",
    parent,
    attributes: spanAttributes({
      "http.request.method": request.method,
      "url.path": url.pathname,
      "url.scheme": scheme,
      "server.address": url.hostname,
      "server.port": url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port),
      "user_agent.original": request.headers.get("user-agent") ?? undefined,
      "quickservicets.request_id": requestId,
    }),
  });
  requestSpans.set(request, span);
  return span;
}

/** The attributes of the active requests counter. */
interface Measure {
  attributes: MetricAttributes;
}

/** Counts a request as active, with its method and scheme. */
function startMeasure(request: Request): Measure {
  const scheme = request.url.startsWith("https:") ? "https" : "http";
  const attributes: MetricAttributes = { "http.request.method": request.method, "url.scheme": scheme };
  coreInstruments().activeRequests.add(1, attributes);
  return { attributes };
}

/** Records a request's duration with its method, route (`unmatched` when none matched), status and scheme. */
function endMeasure(measure: Measure, request: Request, state: { route: string | null; req?: ServiceRequest }, status: number, startedAt: number): void {
  const instruments = coreInstruments();
  instruments.activeRequests.add(-1, measure.attributes);
  instruments.serverDuration.record((performance.now() - startedAt) / 1000, {
    ...measure.attributes,
    "http.route": state.route ?? "unmatched",
    "http.response.status_code": status,
    ...tenantAttributes(idOf(state.req?.tenant)),
  });
}

/** The `client` field of a request log entry: the common name of the caller's certificate, when it showed one. */
function clientField(request: Request): { client?: string } {
  const name = clientCertificateOf(request)?.subject.commonName;
  return name === undefined ? {} : { client: name };
}

/** Hands a completed request to the request observers. */
function observeEnd(request: Request, state: { route: string | null; req?: ServiceRequest }, status: number, startedAt: number, observedAt: number): void {
  const userId = idOf(state.req?.user);
  const tenantId = idOf(state.req?.tenant);
  notifyRequestObservers({
    method: request.method,
    route: state.route,
    status,
    durationMs: performance.now() - startedAt,
    ...(userId !== undefined ? { userId } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    startedAt: observedAt,
    ...(state.req ? { req: state.req } : {}),
  });
}

/** The id of a request's user or tenant, as a text. */
const idOf = (value: unknown): string | undefined => {
  const id = (value as { id?: unknown } | undefined)?.id;
  return id === undefined || id === null ? undefined : String(id);
};

/**
 * Ends a request's server span: named after the matched route, with the status, the route, and the client address,
 * user and tenant the request ended with; 5xx sets the status `error`, 4xx leaves it unset.
 */
function endServerSpan(span: Span, request: Request, state: { route: string | null; req?: ServiceRequest }, status: number, before?: (span: Span) => void): void {
  const req = state.req;
  // `req.ip` is read only when the request computed it.
  const ip = req ? Object.getOwnPropertyDescriptor(req, "ip") : undefined;
  span.setAttributes(
    spanAttributes({
      "http.route": state.route ?? undefined,
      "http.response.status_code": status,
      "client.address": ip && "value" in ip ? String(ip.value) : undefined,
      "enduser.id": idOf(req?.user),
      "quickservicets.tenant": idOf(req?.tenant),
    }),
  );
  if (status >= 500) span.setStatus("error");
  before?.(span);
  span.end();
}

/** An error as spans record it: its name and stack kept, its message and stack masked. */
function maskedError(error: unknown, redact: ((text: string) => string) | undefined): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (!redact) return failure;
  const masked = new Error(redact(failure.message));
  masked.name = failure.name;
  masked.stack = failure.stack === undefined ? undefined : redact(failure.stack);
  return masked;
}

export function createServer({ routes, repos, config: serverConfig, jobs = noRequestJobs, middleware, requestProperties, clientIp, maxRequestBodySize, idleTimeout, mask, entityTags, repositories, requestLogTenant, websocket, clientCertificates }: ServerOptions): Server {
  // Development error responses show the stack with known secret values masked.
  const config = mask ? { ...serverConfig, redact: (text: string) => mask.text(text) } : serverConfig;
  const handlerStage = middleware?.handler ?? [];
  const errorStage = middleware?.error ?? [];
  const requestStage = middleware?.request ?? [];
  // A resolver chooses each request's repositories right before its hooks and handler; without one, nothing runs for it.
  const resolve = repositories?.request as ((req: ServiceRequest) => Repositories) | undefined;
  const resolved = resolve ? routes.map((route) => {
    const inner = route.handler;
    return { ...route, handler: ((_repos, req, res) => inner(resolve(req), req, res)) as Endpoint };
  }) : routes;
  // Handler middlewares wrap each route's hooks and handler once, here, so requests without them pay nothing.
  const wrapped = handlerStage.length === 0 ? resolved : resolved.map((route) => {
    const inner = route.handler;
    const composed = composeHandlerStage(handlerStage, async (req, res) => inner(repos, req, res));
    return { ...route, handler: ((_repos, req, res) => composed(req, res)) as Endpoint };
  });
  const router = new Router(wrapped.map((route) => ({ method: route.method, path: route.path, value: route })));
  const properties = requestProperties && requestProperties.size > 0 ? requestProperties : undefined;

  const logger = config.logger ?? jsonLogger;

  const errorResponse = async (error: unknown, request: Request, requestId: string, state: { req?: ServiceRequest; span?: Span }): Promise<Response> => {
    if (state.span && !(error instanceof HttpError && error.status < 500)) state.span.recordException(maskedError(error, mask ? (text) => mask.text(text) : undefined));
    if (!(error instanceof HttpError)) {
      const failure = error instanceof Error ? error : new Error(String(error));
      safeLog(logger, "error", {
        timestamp: new Date().toISOString(),
        requestId,
        error: { name: failure.name, message: failure.message, stack: failure.stack },
      });
    }
    for (const handler of errorStage) {
      try {
        const response = await handler.run(error, { request, requestId, ...(state.req ? { req: state.req } : {}) });
        if (response instanceof Response) return response;
      } catch (failure) {
        const thrown = failure instanceof Error ? failure : new Error(String(failure));
        safeLog(logger, "error", {
          timestamp: new Date().toISOString(),
          requestId,
          message: "middleware.error",
          error: { name: thrown.name, message: thrown.message, stack: thrown.stack },
        });
      }
    }
    return toErrorResponse(error, config);
  };

  const handle = async (request: Request, requestId: string, state: { route: string | null; req?: ServiceRequest; quiet?: boolean; span?: Span }, parsed?: URL) => {
    try {
      const url = parsed ?? new URL(request.url);
      const match = router.match(request.method, url.pathname);
      if (match.kind === "notFound") throw new HttpError(404, "Route not found");
      if (match.kind === "methodNotAllowed") {
        const response = toErrorResponse(new HttpError(405, "Method not allowed"), config);
        response.headers.set("allow", match.allow.join(", "));
        return response;
      }
      state.route = match.route.value.path;
      if (state.span) state.span.updateName(`${request.method} ${state.route}`);
      if (match.route.value.log === false) state.quiet = true;
      const req = createRequest(request, url, match.params, requestId, jobs, match.route.value.path, clientIp);
      state.req = properties ? withRequestProperties(req, properties) : req;
      const res = new ResponseControls(request, entityTags);
      res.defaultStatus = match.route.value.status;
      const result = await match.route.value.handler(repos, state.req, res);
      return toResponse(result, res, match.route.value.status);
    } catch (error) {
      if (errorStage.length === 0 && error instanceof HttpError) return toErrorResponse(error, config);
      return errorResponse(error, request, requestId, state);
    }
  };

  type State = { route: string | null; req?: ServiceRequest; quiet?: boolean; span?: Span };
  const pipeline =
    requestStage.length === 0
      ? handle
      : (request: Request, requestId: string, state: State) => {
          const url = new URL(request.url);
          const run = composeRequestStage(requestStage, () => handle(request, requestId, state, url));
          const fail = (error: unknown) => errorResponse(error, request, requestId, state);
          return run({ request, url, requestId, errorResponse: fail }).catch(fail);
        };

  const fetch = async (request: Request, options?: FetchOptions): Promise<Response> => {
    if (options?.peer !== undefined) peers.set(request, normalizeAddress(options.peer) ?? options.peer);
    const startedAt = performance.now();
    const requestId = requestIdOf(request);
    const state: State = { route: null };
    // With a tracer, the whole pipeline runs in the request's server span.
    const span = tracingEnabled() ? serverSpan(request, requestId) : undefined;
    if (span) state.span = span;
    // With a meter, the request counts as active until it ends.
    const metered = metricsEnabled() ? startMeasure(request) : undefined;
    // With request observers, the wall-clock start is kept for the observation.
    const observedAt = requestsObserved() ? Date.now() : undefined;
    const answered = span ? await withSpan(span, () => pipeline(request, requestId, state)) : await pipeline(request, requestId, state);
    const observed = span !== undefined || metered !== undefined || observedAt !== undefined;
    /** Ends what waits for the request's end: its span, its measurements and its observers. */
    const complete = (status: number, event?: (span: Span) => void) => {
      if (span) endServerSpan(span, request, state, status, event);
      if (metered) endMeasure(metered, request, state, status, startedAt);
      if (observedAt !== undefined) observeEnd(request, state, status, startedAt, observedAt);
    };
    // An upgraded request is answered by Bun with 101; its socket writes the log entry when it closes.
    if (upgraded.has(request)) {
      if (observed) upgradeEnds.set(request, (closeCode) => complete(101, (open) => open.addEvent("websocket.closed", { "websocket.close.code": closeCode })));
      return undefined as unknown as Response;
    }
    const deferred = deferredLogs.get(answered);
    const response = withHeader(answered, "x-request-id", requestId);
    if (observed) {
      // A streaming response ends when its stream closes.
      if (deferred) {
        void deferred.then(
          (extra) => complete(response.status, (open) => open.addEvent("sse.message", { "quickservicets.sse.messages": Number(extra.messages ?? 0) })),
          () => complete(response.status),
        );
      } else complete(response.status);
    }
    if (state.quiet && response.status < 500) return response;
    const write = (extra: Record<string, unknown>) =>
      safeLog(logger, response.status >= 500 ? "error" : "info", {
        [REQUEST_LOG]: true,
        timestamp: new Date().toISOString(),
        requestId,
        method: request.method,
        route: state.route,
        status: response.status,
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        hooks: state.req ? executedHooks(state.req) : [],
        ...(requestLogTenant && state.req?.tenant ? { tenant: (state.req.tenant as { id?: string }).id } : {}),
        ...(clientCertificates ? clientField(request) : {}),
        ...extra,
      });
    if (deferred) void deferred.then(write, () => write({}));
    else write({});
    return response;
  };

  return {
    fetch,
    listen(port = config.server?.port) {
      const tlsConfig = config.server?.tls as (ServerTlsConfig & { watch?: boolean; reloadInterval?: string }) | undefined;
      // With server.tls, the files are watched and changed certificates reach new connections without a restart.
      const reloader = (apply: (next: ReloadedTls) => void | Promise<void>) => {
        if (!tlsConfig) return undefined;
        const watcher = new TlsReloader({ tls: tlsConfig, ...(clientCertificates?.sources ? { clientCa: clientCertificates.sources } : {}), logger, apply, restart: requestTlsRestart });
        watcher.start();
        return watcher;
      };
      if (clientCertificates && tlsConfig) {
        const tls = loadServerTls(tlsConfig);
        const listener = listenWithClientCertificates({
          port: port ?? 0,
          tls: { cert: tls.cert, key: tls.key, ...(tls.ca ? { ca: tls.ca } : {}), ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}), secureOptions: tls.secureOptions },
          clientCa: clientCertificates.ca,
          required: clientCertificates.required,
          ...(idleTimeout !== undefined ? { idleTimeout } : {}),
          fetch: (request, peer) => fetch(request, { peer }),
        });
        const watcher = reloader((next) =>
          listener.reload({ tls: { cert: next.cert, key: next.key, ...(next.passphrase !== undefined ? { passphrase: next.passphrase } : {}), secureOptions: next.secureOptions }, ...(next.clientCa ? { clientCa: next.clientCa } : {}) }),
        );
        return {
          port: listener.port,
          stop: (close?: boolean) => {
            watcher?.stop();
            return listener.stop(close);
          },
        } as unknown as ReturnType<typeof Bun.serve>;
      }
      const watched = tlsConfig !== undefined && tlsConfig.watch !== false;
      /** Starts a Bun server on the port, with the given TLS options. */
      const serve = (listenPort: number | undefined, tls: Record<string, unknown> | undefined) => {
        const options = {
          port: listenPort,
          fetch: (request: Request, server: BunServer & { requestIP(request: Request): { address: string } | null }) => {
            // The peer address is read from the server only when a request asks for it.
            peers.set(request, server);
            if (websocket) servers.set(request, server);
            return fetch(request);
          },
          // Bun's WebSocket handler is passed only when a socket route exists.
          ...(websocket ? { websocket } : {}),
          // Worker processes share the port (on Linux the kernel spreads the connections across them), and a reloaded
          // certificate starts a new listener on it before the old one closes.
          ...((config.server?.workers ?? 1) > 1 || watched ? { reusePort: true } : {}),
          ...(maxRequestBodySize !== undefined ? { maxRequestBodySize } : {}),
          ...(idleTimeout !== undefined ? { idleTimeout } : {}),
          // With server.tls the port answers HTTPS only.
          ...(tls ? { tls } : {}),
        };
        return Bun.serve(options as unknown as Parameters<typeof Bun.serve>[0]);
      };
      let current = serve(port, tlsConfig ? bunTlsOptions(loadServerTls(tlsConfig)) : undefined);
      if (!tlsConfig) return current;
      const retired = new Set<ReturnType<typeof Bun.serve>>();
      // Bun's server.reload keeps the TLS options it started with, so a new listener with the new certificates takes
      // the port and the old one stops accepting, letting its requests in progress finish.
      const watcher = reloader((next) => {
        const replacement = serve(current.port, { cert: next.cert, key: next.key, ...(next.ca ? { ca: next.ca } : {}), ...(next.passphrase !== undefined ? { passphrase: next.passphrase } : {}), secureOptions: next.secureOptions });
        const previous = current;
        current = replacement;
        retired.add(previous);
        void Promise.resolve(previous.stop(false)).finally(() => retired.delete(previous));
      });
      return {
        get port() {
          return current.port;
        },
        stop: async (close?: boolean) => {
          watcher?.stop();
          await Promise.all([current.stop(close), ...[...retired].map((server) => server.stop(close))]);
        },
      } as unknown as ReturnType<typeof Bun.serve>;
    },
  };
}

export { ResponseControls };
