import { HttpError, toErrorResponse } from "../errors.ts";
import type { Repositories, ServiceRequest, ServiceResponse } from "../hooks.ts";
import { noRequestJobs, type RequestJobs } from "../jobs/triggers.ts";
import { jsonLogger, safeLog, type Logger } from "../logger.ts";
import { executedHooks } from "./pipeline.ts";
import { composeHandlerStage, composeRequestStage, type MiddlewareStages } from "../middleware.ts";
import { Router } from "./router.ts";

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
}

export interface ServerOptions {
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

export interface Server {
  fetch(request: Request): Promise<Response>;
  listen(port?: number): ReturnType<typeof Bun.serve>;
}

class ResponseControls implements ServiceResponse {
  statusCode: number | undefined;
  readonly headers = new Headers();

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

function createRequest(raw: Request, url: URL, params: Record<string, string>, id: string, jobs: RequestJobs, route: string): ServiceRequest {
  let body: Promise<unknown> | undefined;
  return {
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
      body ??= raw.text().then((text) => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new HttpError(400, "Invalid JSON body");
        }
      });
      return body;
    },
  };
}

/** The response for a handler's result; `status` replaces the default 200 (or 204 for `undefined`) when `res.status` was not called. */
export function toResponse(result: unknown, res: ResponseControls, status?: number): Response {
  if (result instanceof Response) return result;
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

export function createServer({ routes, repos, config, jobs = noRequestJobs, middleware, requestProperties }: ServerOptions): Server {
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

  const handle = async (request: Request, requestId: string, state: { route: string | null; req?: ServiceRequest }, parsed?: URL) => {
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
      const req = createRequest(request, url, match.params, requestId, jobs, match.route.value.path);
      state.req = properties ? withRequestProperties(req, properties) : req;
      const res = new ResponseControls();
      const result = await match.route.value.handler(repos, state.req, res);
      return toResponse(result, res, match.route.value.status);
    } catch (error) {
      if (errorStage.length === 0 && error instanceof HttpError) return toErrorResponse(error, config);
      return errorResponse(error, request, requestId, state);
    }
  };

  type State = { route: string | null; req?: ServiceRequest };
  const pipeline =
    requestStage.length === 0
      ? handle
      : (request: Request, requestId: string, state: State) => {
          const url = new URL(request.url);
          const run = composeRequestStage(requestStage, () => handle(request, requestId, state, url));
          return run({ request, url, requestId }).catch((error: unknown) => errorResponse(error, request, requestId, state));
        };

  const fetch = async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    const requestId = requestIdOf(request);
    const state: State = { route: null };
    const response = withHeader(await pipeline(request, requestId, state), "x-request-id", requestId);
    safeLog(logger, response.status >= 500 ? "error" : "info", {
      timestamp: new Date().toISOString(),
      requestId,
      method: request.method,
      route: state.route,
      status: response.status,
      durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      hooks: state.req ? executedHooks(state.req) : [],
    });
    return response;
  };

  return {
    fetch,
    listen(port = config.server?.port) {
      // Worker processes share the port; on Linux the kernel spreads the connections across them.
      return Bun.serve({ port, fetch, ...((config.server?.workers ?? 1) > 1 ? { reusePort: true } : {}) });
    },
  };
}

export { ResponseControls };
