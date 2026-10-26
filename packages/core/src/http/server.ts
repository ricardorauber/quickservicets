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
}

export interface ServerOptions extends ServerSettings {
  routes: Route[];
  repos: Repositories;
  config: { production: boolean; server?: { port: number; workers?: number }; logger?: Logger };
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

export function createServer({ routes, repos, config: serverConfig, jobs = noRequestJobs, middleware, requestProperties, clientIp, maxRequestBodySize, idleTimeout, mask, entityTags }: ServerOptions): Server {
  // Development error responses show the stack with known secret values masked.
  const config = mask ? { ...serverConfig, redact: (text: string) => mask.text(text) } : serverConfig;
  const handlerStage = middleware?.handler ?? [];
  const errorStage = middleware?.error ?? [];
  const requestStage = middleware?.request ?? [];
  // Handler middlewares wrap each route's hooks and handler once, here, so requests without them pay nothing.
  const wrapped = handlerStage.length === 0 ? routes : routes.map((route) => {
    const inner = route.handler;
    const composed = composeHandlerStage(handlerStage, async (req, res) => inner(repos, req, res));
    return { ...route, handler: ((_repos, req, res) => composed(req, res)) as Endpoint };
  });
  const router = new Router(wrapped.map((route) => ({ method: route.method, path: route.path, value: route })));
  const properties = requestProperties && requestProperties.size > 0 ? requestProperties : undefined;

  const logger = config.logger ?? jsonLogger;

  const errorResponse = async (error: unknown, request: Request, requestId: string, state: { req?: ServiceRequest }): Promise<Response> => {
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

  const handle = async (request: Request, requestId: string, state: { route: string | null; req?: ServiceRequest; quiet?: boolean }, parsed?: URL) => {
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

  type State = { route: string | null; req?: ServiceRequest; quiet?: boolean };
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
    const answered = await pipeline(request, requestId, state);
    const deferred = deferredLogs.get(answered);
    const response = withHeader(answered, "x-request-id", requestId);
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
        ...extra,
      });
    if (deferred) void deferred.then(write, () => write({}));
    else write({});
    return response;
  };

  return {
    fetch,
    listen(port = config.server?.port) {
      // Worker processes share the port; on Linux the kernel spreads the connections across them.
      return Bun.serve({
        port,
        fetch: (request, server) => {
          // The peer address is read from the server only when a request asks for it.
          peers.set(request, server);
          return fetch(request);
        },
        ...((config.server?.workers ?? 1) > 1 ? { reusePort: true } : {}),
        ...(maxRequestBodySize !== undefined ? { maxRequestBodySize } : {}),
        ...(idleTimeout !== undefined ? { idleTimeout } : {}),
      });
    },
  };
}

export { ResponseControls };
