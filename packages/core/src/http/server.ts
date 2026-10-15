import { HttpError, toErrorResponse } from "../errors.ts";
import type { Repositories, ServiceRequest, ServiceResponse } from "../hooks.ts";
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
  config: { production: boolean; server?: { port: number } };
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

function createRequest(raw: Request, url: URL, params: Record<string, string>): ServiceRequest {
  let body: Promise<unknown> | undefined;
  return {
    method: raw.method,
    path: url.pathname,
    params,
    query: url.searchParams,
    headers: raw.headers,
    raw,
    context: {},
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

  const fetch = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const match = router.match(request.method, url.pathname);
      if (match.kind === "notFound") throw new HttpError(404, "Route not found");
      if (match.kind === "methodNotAllowed") {
        const response = toErrorResponse(new HttpError(405, "Method not allowed"), config);
        response.headers.set("allow", match.allow.join(", "));
        return response;
      }
      const res = new ResponseControls();
      const result = await match.route.value.handler(repos, createRequest(request, url, match.params), res);
      return toResponse(result, res);
    } catch (error) {
      return toErrorResponse(error, config);
    }
  };

  return {
    fetch,
    listen(port = config.server?.port) {
      return Bun.serve({ port, fetch });
    },
  };
}

export { ResponseControls };
