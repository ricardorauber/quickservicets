import type { ServiceRequest, ServiceResponse } from "./hooks.ts";
import type { HandlerResult } from "./http/server.ts";

/** What a `request` middleware receives: the raw request before routing. */
export interface RequestStageContext {
  request: Request;
  url: URL;
  requestId: string;
  /**
   * The response the `error` stage gives an error, as if it was thrown by the rest of the pipeline; a middleware that
   * refuses a request uses it to keep changing the response on its way out.
   */
  errorResponse(error: unknown): Promise<Response>;
}

/** What an `error` middleware receives besides the error. */
export interface ErrorStageContext {
  request: Request;
  requestId: string;
  /** The request hooks and handlers receive, when routing happened. */
  req?: ServiceRequest;
}

/** Runs for every request before routing, unmatched ones included; `next()` returns the response of the rest of the pipeline. */
export interface RequestMiddleware {
  stage: "request";
  /** Lower runs first and outermost (default 0). */
  order?: number;
  run(ctx: RequestStageContext, next: () => Promise<Response>): Response | Promise<Response>;
}

/**
 * Runs after routing around the route's hooks and handler, with the request they receive; it may set `req.user`,
 * `req.tenant` and `req.flags`, return a result without calling `next`, or throw an `HttpError`.
 */
export interface HandlerMiddleware {
  stage: "handler";
  /** Lower runs first and outermost (default 0). */
  order?: number;
  run(req: ServiceRequest, res: ServiceResponse, next: () => Promise<HandlerResult<unknown>>): HandlerResult<unknown> | Promise<HandlerResult<unknown>>;
}

/** Runs for every error of the pipeline; the first one returning a `Response` decides the response. */
export interface ErrorMiddleware {
  stage: "error";
  /** Lower runs first (default 0). */
  order?: number;
  run(error: unknown, ctx: ErrorStageContext): Response | undefined | void | Promise<Response | undefined | void>;
}

/** A middleware of the `request`, `handler` or `error` stage. */
export type Middleware = RequestMiddleware | HandlerMiddleware | ErrorMiddleware;

/** A middleware with who registered it: a feature's key, or `project` for the config's `middleware` key. */
export interface OwnedMiddleware {
  owner: string;
  middleware: Middleware;
}

/** The middlewares of each stage, in the order they run. */
export interface MiddlewareStages {
  request: RequestMiddleware[];
  handler: HandlerMiddleware[];
  error: ErrorMiddleware[];
}

const STAGES = ["request", "handler", "error"] as const;

/**
 * Orders middlewares by stage: the features' by `order` ascending, then feature order, then declaration order; the
 * project's after every feature's, by `order` too. Fails naming the owner of a middleware that is not one.
 */
export function middlewareStages(features: readonly OwnedMiddleware[], project: readonly Middleware[] = []): MiddlewareStages {
  const check = (entry: OwnedMiddleware) => {
    const { middleware } = entry;
    if (typeof middleware !== "object" || middleware === null || !STAGES.includes(middleware.stage) || typeof middleware.run !== "function") {
      throw new Error(`Invalid middleware of ${entry.owner}: expected { stage: "request" | "handler" | "error", run, order? }`);
    }
    if (middleware.order !== undefined && !Number.isFinite(middleware.order)) throw new Error(`Invalid middleware of ${entry.owner}: order must be a number`);
  };
  const sorted = (entries: readonly OwnedMiddleware[]) => {
    entries.forEach(check);
    return entries.map((entry, index) => ({ entry, index })).sort((a, b) => (a.entry.middleware.order ?? 0) - (b.entry.middleware.order ?? 0) || a.index - b.index);
  };
  const all = [...sorted(features), ...sorted(project.map((middleware) => ({ owner: "project", middleware })))].map(({ entry }) => entry.middleware);
  return {
    request: all.filter((middleware): middleware is RequestMiddleware => middleware.stage === "request"),
    handler: all.filter((middleware): middleware is HandlerMiddleware => middleware.stage === "handler"),
    error: all.filter((middleware): middleware is ErrorMiddleware => middleware.stage === "error"),
  };
}

/** Wraps `inner` in the request middlewares, the first outermost. */
export function composeRequestStage(middlewares: readonly RequestMiddleware[], inner: (ctx: RequestStageContext) => Promise<Response>): (ctx: RequestStageContext) => Promise<Response> {
  return middlewares.reduceRight<(ctx: RequestStageContext) => Promise<Response>>(
    (next, middleware) => async (ctx) => middleware.run(ctx, () => next(ctx)),
    inner,
  );
}

type Handler = (req: ServiceRequest, res: ServiceResponse) => Promise<HandlerResult<unknown>>;

/** Wraps a route's hooks and handler in the handler middlewares, the first outermost. */
export function composeHandlerStage(middlewares: readonly HandlerMiddleware[], inner: Handler): Handler {
  return middlewares.reduceRight<Handler>((next, middleware) => async (req, res) => middleware.run(req, res, () => next(req, res)), inner);
}
