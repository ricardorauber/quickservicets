import type { HandlerMiddleware, HttpError, RequestMiddleware, RequestStageContext, ServiceRequest } from "../public.ts";
import type { Exemptions } from "./exempt.ts";
import type { RouteIndex, SecurityRoute } from "./routes.ts";
import type { RateLimitResult } from "./store.ts";

/** The security items, as the native's option keys. */
export const SECURITY_ITEMS = ["proxy", "headers", "files", "cors", "limits", "timeouts", "loadShedding", "rateLimit", "ip", "masking", "csrf"] as const;

/** One security item, by its option key. */
export type SecurityItem = (typeof SECURITY_ITEMS)[number];

/**
 * The steps of the request stage, in the order their checks run: load shedding, URL and header limits, IP lists, CORS,
 * rate limits keyed by address or route, the body policy; and the security headers, which only add to the response.
 */
export const STEP_ORDER = ["loadShedding", "limits", "ip", "cors", "rateLimit", "body", "headers"] as const;

/** A step of the security middlewares, by its place in `STEP_ORDER`. */
export type StepName = (typeof STEP_ORDER)[number];

/** The order the steps add their response headers in, on the way out. */
const RESPONSE_ORDER: readonly StepName[] = ["headers", "cors", "rateLimit", "loadShedding", "limits", "ip", "body"];

/** The items whose refusals have a hook. */
export type RefusingItem = "rateLimit" | "ip" | "cors" | "loadShedding" | "limits";

/** A refusal a step decided: the item, the error's message, and what the item adds (the key and limit of a rate limit). */
export interface Refusal {
  item: RefusingItem;
  reason: string;
  details?: Record<string, unknown>;
}

/** Called with each refusal once it is decided, with the request's state. */
export type RefusalListener = (state: SecurityState, refusal: Refusal) => void;

/** What one request carries through the security steps. */
export class SecurityState {
  /** The items this request's path is exempted from, as a mask of `EXEMPT` bits. */
  readonly exempt: number;
  private found: SecurityRoute | undefined | null = null;

  constructor(
    readonly ctx: RequestStageContext,
    exemptions: Exemptions,
    private readonly index: RouteIndex | undefined,
  ) {
    this.exempt = exemptions.empty ? 0 : exemptions.match(ctx.url.pathname);
  }

  /** The tagged route the request matches, looked up once; undefined without security tags or without a match. */
  get route(): SecurityRoute | undefined {
    if (this.found === null) this.found = this.index?.find(this.ctx.request.method, this.ctx.url.pathname);
    return this.found;
  }

  /** Values steps hand to later steps or to the way out, by name. */
  values: Record<string, unknown> | undefined;
  /** Whether load shedding counts the request among those in flight. */
  counted = false;
  /** The rate limit decision whose headers the response carries: the bucket with the fewest requests left. */
  rateLimit: RateLimitResult | undefined;
  /** The refusal a step decided, for the item's hook. */
  refusal: Refusal | undefined;

  /** Records the refusal of an item and returns its error, for the step to throw. */
  refuse(item: RefusingItem, error: HttpError, details?: Record<string, unknown>): HttpError {
    this.refusal = { item, reason: error.message, ...(details ? { details } : {}) };
    return error;
  }
}

/** One step of the security middlewares, implemented by an item. */
export interface SecurityStep {
  /** Where the step runs. */
  readonly name: StepName;
  /** Runs before the rest of the pipeline: throws an `HttpError` to refuse the request, or returns a `Response` to answer it. */
  before?(state: SecurityState): void | Response | Promise<void | Response>;
  /** Changes the response on its way out, refusals included. */
  after?(response: Response, state: SecurityState): Response;
  /** Runs once the rest of the pipeline returned its response or failed. */
  done?(state: SecurityState): void;
  /** Runs in the handler stage, after the middlewares that set `req.user` and `req.tenant`; throws an `HttpError` to refuse. */
  handler?(req: ServiceRequest, state: SecurityState): void | Promise<void>;
}

/** The security middlewares of a set of steps: one `request` middleware, and a `handler` one only when a step needs it. */
export interface SecurityMiddlewares {
  request: RequestMiddleware;
  handler?: HandlerMiddleware;
}

const position = (order: readonly StepName[], step: SecurityStep) => order.indexOf(step.name);

/**
 * Builds the security middlewares: the outermost `request` middleware (order -1000) runs the steps' checks in
 * `STEP_ORDER` and adds their response headers on the way out; the `handler` middleware (order 1000, inside the
 * middlewares with the default order) runs the steps that need `req.user` or `req.tenant`.
 */
export function securityMiddlewares(steps: readonly SecurityStep[], exemptions: Exemptions, index: () => RouteIndex | undefined, onRefusal?: RefusalListener): SecurityMiddlewares {
  const sorted = [...steps].sort((a, b) => position(STEP_ORDER, a) - position(STEP_ORDER, b));
  const before = sorted.filter((step) => step.before).map((step) => step.before!.bind(step));
  const after = [...steps].sort((a, b) => position(RESPONSE_ORDER, a) - position(RESPONSE_ORDER, b)).filter((step) => step.after).map((step) => step.after!.bind(step));
  const done = sorted.filter((step) => step.done).map((step) => step.done!.bind(step));
  const handlers = sorted.filter((step) => step.handler).map((step) => step.handler!.bind(step));
  // The handler middleware finds the request's state by the native request.
  const states = handlers.length > 0 ? new WeakMap<Request, SecurityState>() : undefined;

  const request: RequestMiddleware = {
    stage: "request",
    order: -1000,
    async run(ctx, next) {
      const state = new SecurityState(ctx, exemptions, index());
      let response: Response | undefined;
      try {
        for (const check of before) {
          const answer = check(state);
          response = answer instanceof Promise ? ((await answer) ?? undefined) : (answer ?? undefined);
          if (response) break;
        }
        if (!response) {
          states?.set(ctx.request, state);
          response = await next();
        }
      } catch (error) {
        if (state.refusal && onRefusal) onRefusal(state, state.refusal);
        response = await ctx.errorResponse(error);
      } finally {
        for (const finish of done) finish(state);
      }
      for (const add of after) response = add(response, state);
      return response;
    },
  };
  if (!states) return { request };
  const handler: HandlerMiddleware = {
    stage: "handler",
    order: 1000,
    async run(req, _res, next) {
      const state = states.get(req.raw);
      if (state) {
        try {
          for (const check of handlers) await check(req, state);
        } catch (error) {
          if (state.refusal && onRefusal) onRefusal(state, state.refusal);
          throw error;
        }
      }
      return next();
    },
  };
  return { request, handler };
}
