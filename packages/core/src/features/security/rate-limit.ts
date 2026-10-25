import { HttpError, parseRate, resolveOption, Router, type OptionFunction, type Rate, type ServiceRequest, type TaggedRoute } from "../public.ts";
import { EXEMPT } from "./exempt.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";
import type { SecurityRoute } from "./routes.ts";
import type { RateLimitResult, RateLimitStore } from "./store.ts";

/** The parts a rate limit key can be made of, in the order they are joined. */
export const KEY_PARTS = ["route", "ip", "user", "tenant"] as const;

/** One part of a rate limit key. */
export type KeyPart = (typeof KEY_PARTS)[number];

/** The `rateLimit` item's options this step uses. */
export interface RateLimitOptions {
  enabled: boolean;
  limit: string | OptionFunction<string>;
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
  /** The route patterns, when the global key includes `route`. */
  routes?: RoutePatterns;
  /** The routes with a security tag, to know whether a `@rateLimit` needs the handler stage. */
  tagged?: readonly SecurityRoute[];
  /** The time of a hit (default `Date.now`). */
  now?: () => number;
}

/** One rate limit: its limit (a rate, or a function of the request), the parts of its key and where it runs. */
interface Bucket {
  limit: string | OptionFunction<string>;
  parts: readonly KeyPart[];
  /** Keys of route buckets start with it, so they never share counters with the global limit. */
  prefix: string;
  /** Whether it needs `req.user`, `req.tenant` or a per-request limit, so it runs in the handler stage. */
  late: boolean;
}

const bucketOf = (limit: Bucket["limit"], parts: readonly KeyPart[], prefix: string): Bucket => ({
  limit,
  parts,
  prefix,
  late: typeof limit === "function" || parts.includes("user") || parts.includes("tenant"),
});

/** The bucket of a route's `@rateLimit` tag: its own limit and `by` (or the global ones), always keyed by route too. */
function routeBucket(options: RateLimitOptions, route: SecurityRoute): Bucket | undefined {
  const tag = route.tags.rateLimit;
  if (!tag?.on) return undefined;
  let bucket = route.cache.get("rateLimit") as Bucket | undefined;
  if (!bucket) {
    const own = tag.options as { limit?: string; by?: KeyPart[] };
    bucket = bucketOf(own.limit ?? options.limit, keyParts(["route", ...(own.by ?? options.by)]), "tag|");
    route.cache.set("rateLimit", bucket);
  }
  return bucket;
}

/** The id of a request's user or tenant, when it has one. */
const idOf = (value: unknown): string | undefined => {
  const id = (value as { id?: unknown } | undefined)?.id;
  return id === undefined || id === null ? undefined : String(id);
};

/**
 * The step of the `rateLimit` item. The global limit applies to every request that is not exempted, and a route's
 * `@rateLimit` adds its own bucket; a request is refused when either refuses it, and the `RateLimit-*` headers describe
 * the bucket with the fewest requests left. Limits keyed by address or route run before routing; limits keyed by user
 * or tenant, or computed per request, run in the handler stage, once `req.user` and `req.tenant` are set.
 */
export function rateLimitStep(options: RateLimitOptions, context: RateLimitContext): SecurityStep {
  const now = context.now ?? Date.now;
  const { store, ipOf } = context;
  const global = bucketOf(options.limit, keyParts(options.by), "");
  const rates = new Map<string, Rate>();
  const rateOf = (text: string) => {
    let parsed = rates.get(text);
    if (!parsed) rates.set(text, (parsed = parseRate(text)));
    return parsed;
  };
  const keyOf = (bucket: Bucket, state: SecurityState, req?: ServiceRequest): string => {
    const { request, url } = state.ctx;
    const ip = req ? req.ip : ipOf(request);
    // With the default `by`, the address alone is the key.
    if (bucket.prefix === "" && bucket.parts.length === 1 && bucket.parts[0] === "ip") return ip;
    let key = bucket.prefix;
    for (const part of bucket.parts) {
      if (key !== bucket.prefix) key += "|";
      if (part === "ip") key += ip;
      else if (part === "route") key += state.route && bucket.prefix !== "" ? `${state.route.method} ${state.route.path}` : (context.routes?.of(request.method, url.pathname) ?? "-");
      else {
        const id = idOf(part === "user" ? req?.user : req?.tenant);
        key += id === undefined ? `ip:${ip}` : `${part}:${id}`;
      }
    }
    return key;
  };
  const record = (state: SecurityState, result: RateLimitResult, key: string, limit: string) => {
    if (!state.rateLimit || result.remaining < state.rateLimit.remaining || !result.allowed) state.rateLimit = result;
    if (!result.allowed) throw state.refuse("rateLimit", rateLimited(result), { key, limit });
  };
  const hit = (bucket: Bucket, state: SecurityState, limit: string, req?: ServiceRequest) => {
    const { count, windowMs } = rateOf(limit);
    const key = keyOf(bucket, state, req);
    const result = store.hit(key, { limit: count, windowMs, now: now() });
    if (result instanceof Promise) return result.then((settled) => record(state, settled, key, limit));
    record(state, result, key, limit);
  };
  /** Whether rate limits apply to the request at all: not exempted, and not on a route tagged `@rateLimit off`. */
  const applies = (state: SecurityState) => !(state.exempt & EXEMPT.rateLimit) && state.route?.tags.rateLimit?.on !== false;
  const lateRoutes = (context.tagged ?? []).some((route) => routeBucket(options, route)?.late);
  const step: SecurityStep = {
    name: "rateLimit",
    before(state: SecurityState) {
      if (!applies(state)) return;
      const own = state.route ? routeBucket(options, state.route) : undefined;
      const first = global.late ? undefined : hit(global, state, global.limit as string);
      if (!own || own.late) return first;
      return first ? first.then(() => hit(own, state, own.limit as string)) : hit(own, state, own.limit as string);
    },
    after(response: Response, state: SecurityState) {
      return state.rateLimit ? withRateLimitHeaders(response, state.rateLimit) : response;
    },
  };
  if (global.late || lateRoutes) {
    step.handler = async (req: ServiceRequest, state: SecurityState) => {
      if (!applies(state)) return;
      for (const bucket of [global, state.route ? routeBucket(options, state.route) : undefined]) {
        if (!bucket?.late) continue;
        const limit = typeof bucket.limit === "function" ? await resolveOption(bucket.limit, { req }) : bucket.limit;
        await hit(bucket, state, limit, req);
      }
    };
  }
  return step;
}
