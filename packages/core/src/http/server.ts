import { HttpError, toErrorResponse } from "../errors.ts";
import type { Repositories, ServiceRequest, ServiceResponse } from "../hooks.ts";
import { jsonLogger, safeLog, type Logger } from "../logger.ts";
import { executedHooks } from "./pipeline.ts";
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
}

export interface ServerOptions {
  routes: Route[];
  repos: Repositories;
  config: { production: boolean; server?: { port: number }; logger?: Logger };
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

function createRequest(raw: Request, url: URL, params: Record<string, string>, id: string): ServiceRequest {
  let body: Promise<unknown> | undefined;
  return {
    id,
    method: raw.method,
    path: url.pathname,
    params,
    query: url.searchParams,
    headers: raw.headers,
    raw,
    context: {},
    queryItems: {},
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

export function toResponse(result: unknown, res: ResponseControls): Response {
  if (result instanceof Response) return result;
  if (result === undefined) {
    return new Response(null, { status: res.statusCode ?? 204, headers: res.headers });
  }
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(result), { status: res.statusCode ?? 200, headers });
}

export function createServer({ routes, repos, config }: ServerOptions): Server {
  const router = new Router(routes.map((route) => ({ method: route.method, path: route.path, value: route })));

  const logger = config.logger ?? jsonLogger;

  const handle = async (request: Request, requestId: string, state: { route: string | null; req?: ServiceRequest }) => {
    try {
      const url = new URL(request.url);
      const match = router.match(request.method, url.pathname);
      if (match.kind === "notFound") throw new HttpError(404, "Route not found");
      if (match.kind === "methodNotAllowed") {
        const response = toErrorResponse(new HttpError(405, "Method not allowed"), config);
        response.headers.set("allow", match.allow.join(", "));
        return response;
      }
      state.route = match.route.value.path;
      state.req = createRequest(request, url, match.params, requestId);
      const res = new ResponseControls();
      const result = await match.route.value.handler(repos, state.req, res);
      return toResponse(result, res);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        const failure = error instanceof Error ? error : new Error(String(error));
        safeLog(logger, "error", {
          timestamp: new Date().toISOString(),
          requestId,
          error: { name: failure.name, message: failure.message, stack: failure.stack },
        });
      }
      return toErrorResponse(error, config);
    }
  };

  const fetch = async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    const requestId = requestIdOf(request);
    const state: { route: string | null; req?: ServiceRequest } = { route: null };
    const response = withHeader(await handle(request, requestId, state), "x-request-id", requestId);
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
      return Bun.serve({ port, fetch });
    },
  };
}

export { ResponseControls };
