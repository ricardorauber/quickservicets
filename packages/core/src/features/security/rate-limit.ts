import { HttpError, parseRate, Router, type TaggedRoute } from "../public.ts";
import { EXEMPT } from "./exempt.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";
import type { RateLimitResult, RateLimitStore } from "./store.ts";

/** The parts a rate limit key can be made of, in the order they are joined. */
export const KEY_PARTS = ["route", "ip", "user", "tenant"] as const;

/** One part of a rate limit key. */
export type KeyPart = (typeof KEY_PARTS)[number];

/** The `rateLimit` item's options this step uses. */
export interface RateLimitOptions {
  enabled: boolean;
  limit: string;
  by: readonly KeyPart[];
}

/** The parts of `by` in the fixed key order, without repeats. */
export function keyParts(by: readonly KeyPart[]): KeyPart[] {
  return KEY_PARTS.filter((part) => by.includes(part));
}

/** Finds the route pattern of a request before routing: `METHOD /path/[param]`, or `-` when no route matches. */
export interface RoutePatterns {
  of(method: string, path: string): string;
}

/** The route patterns of the app's routes, for keys that include `route`. */
export function routePatterns(routes: readonly TaggedRoute[]): RoutePatterns {
  const router = new Router(routes.map((route) => ({ method: route.method, path: route.path, value: `${route.method} ${route.path}` })));
  return {
    of(method, path) {
      try {
        const match = router.match(method, path);
        return match.kind === "found" ? match.route.value : "-";
      } catch {
        return "-";
      }
    },
  };
}

/** The rate limit headers of a decision, and `Retry-After` for a refusal. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "ratelimit-limit": String(result.limit),
    "ratelimit-remaining": String(Math.max(0, result.remaining)),
    "ratelimit-reset": String(Math.ceil(result.resetMs / 1000)),
    ...(result.allowed ? {} : { "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) }),
  };
}

/** The 429 refusal of a decision, carrying its headers. */
export function rateLimited(result: RateLimitResult): HttpError {
  return new HttpError(429, "Too many requests", { headers: rateLimitHeaders(result) });
}

/** Sets the headers of a decision on a response, copying it first when its headers are immutable. */
function withRateLimitHeaders(response: Response, result: RateLimitResult): Response {
  const set = (headers: Headers) => {
    headers.set("ratelimit-limit", String(result.limit));
    headers.set("ratelimit-remaining", String(Math.max(0, result.remaining)));
    headers.set("ratelimit-reset", String(Math.ceil(result.resetMs / 1000)));
    if (!result.allowed && !headers.has("retry-after")) headers.set("retry-after", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
  };
  try {
    set(response.headers);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    set(copy.headers);
    return copy;
  }
}

/** What the rate limit step needs besides its options. */
export interface RateLimitContext {
  store: RateLimitStore;
  /** The client address of a request, as `req.ip` reads it. */
  ipOf(request: Request): string;
  /** The route patterns, when a key includes `route`. */
  routes?: RoutePatterns;
  /** The time of a hit (default `Date.now`). */
  now?: () => number;
}

/**
 * The step of the `rateLimit` item in the request stage: the global limit keyed by the client address (and the route
 * when `by` includes it), answering 429 when it is passed and adding the `RateLimit-*` headers to every response of a
 * limited request.
 */
export function rateLimitStep(options: RateLimitOptions, context: RateLimitContext): SecurityStep {
  const { count: limit, windowMs } = parseRate(options.limit);
  const parts = keyParts(options.by);
  const byRoute = parts.includes("route");
  const now = context.now ?? Date.now;
  const { store, ipOf } = context;
  const keyOf = (state: SecurityState): string => {
    const { request, url } = state.ctx;
    const ip = ipOf(request);
    // With the default `by`, the address alone is the key.
    if (!byRoute) return ip;
    return `${context.routes!.of(request.method, url.pathname)}|${ip}`;
  };
  const decide = (state: SecurityState, result: RateLimitResult) => {
    state.rateLimit = result;
    if (!result.allowed) throw rateLimited(result);
  };
  return {
    name: "rateLimit",
    before(state: SecurityState) {
      if (state.exempt & EXEMPT.rateLimit) return;
      const result = store.hit(keyOf(state), { limit, windowMs, now: now() });
      if (result instanceof Promise) return result.then((settled) => decide(state, settled));
      decide(state, result);
    },
    after(response: Response, state: SecurityState) {
      return state.rateLimit ? withRateLimitHeaders(response, state.rateLimit) : response;
    },
  };
}
