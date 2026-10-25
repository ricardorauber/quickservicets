import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { createServer, type Route } from "./http/server.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import { middlewareStages } from "./middleware.ts";
import { Exemptions } from "./features/security/exempt.ts";
import { securityMiddlewares, SecurityState } from "./features/security/pipeline.ts";
import { keyParts, rateLimitStep, routePatterns } from "./features/security/rate-limit.ts";
import { memoryRateLimitStore, slidingWindowHit, type WindowCounts } from "./features/security/store.ts";
// Loading the core registers the natives it ships.
import "./index.ts";

const logs: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
afterEach(() => {
  logs.length = 0;
});

const MINUTE = 60_000;
const ok: Route["handler"] = () => ({ ok: true });
const routes: Route[] = ["/posts", "/tags", "/health/live"].map((path) => ({ method: "GET", path, handler: ok }));

/** A server running the native's middlewares for a configuration. */
async function serve(config: Record<string, unknown>, worker = { index: 0, count: 1, runsScheduledWork: true }) {
  const resolved = resolveConfig({ database: memoryAdapter(), logger, ...config } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker, endpoints: routes.map(({ method, path }) => ({ method, path })) });
  await lifecycle.setup();
  const server = createServer({ routes, repos: {}, config: { production: false, logger }, middleware: middlewareStages(lifecycle.middleware), ...lifecycle.server });
  return (path: string, peer = "203.0.113.5") => server.fetch(new Request(`http://localhost${path}`), { peer });
}

const limitHeaders = (response: Response) => ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"].map((name) => response.headers.get(name));

describe("sliding window", () => {
  test("8 hits at the end of a window leave room for exactly 4 more 15 seconds into the next", () => {
    const counts: WindowCounts = { windowStart: 0, current: 0, previous: 0 };
    const hit = (now: number) => slidingWindowHit(counts, { limit: 10, windowMs: MINUTE, now });
    for (let index = 0; index < 8; index++) expect(hit(59_000 + index).allowed).toBe(true);
    const next = 75_000;
    const later = Array.from({ length: 5 }, () => hit(next));
    expect(later.map((result) => result.allowed)).toEqual([true, true, true, true, false]);
    // The estimate is 8 × 0.75 = 6, plus the 4 counted: nothing remains, and refusals do not lower it further.
    expect(later[3]!.remaining).toBe(0);
    expect(hit(next).remaining).toBe(0);
    expect(counts.current).toBe(4);
    expect(later[4]!.retryAfterMs).toBeGreaterThan(0);
  });

  test("a window two windows later starts from nothing, and the reset is the time left in the window", () => {
    const counts: WindowCounts = { windowStart: 0, current: 0, previous: 0 };
    for (let index = 0; index < 3; index++) slidingWindowHit(counts, { limit: 3, windowMs: MINUTE, now: 10_000 });
    expect(slidingWindowHit(counts, { limit: 3, windowMs: MINUTE, now: 10_000 }).allowed).toBe(false);
    const fresh = slidingWindowHit(counts, { limit: 3, windowMs: MINUTE, now: 2 * MINUTE + 30_000 });
    expect(fresh).toEqual({ allowed: true, limit: 3, remaining: 2, resetMs: 30_000, retryAfterMs: 0 });
  });
});

describe("keys", () => {
  test("the parts of by in the fixed order, and the route of unmatched requests", async () => {
    expect(keyParts(["tenant", "ip", "route"])).toEqual(["route", "ip", "tenant"]);
    const patterns = routePatterns([{ method: "GET", path: "/posts/[id]" }]);
    expect(patterns.of("GET", "/posts/42")).toBe("GET /posts/[id]");
    expect(patterns.of("GET", "/nowhere")).toBe("-");
    const keys: string[] = [];
    const store = memoryRateLimitStore();
    const spied = { hit: (key: string, hit: Parameters<typeof store.hit>[1]) => (keys.push(key), store.hit(key, hit)), reset: store.reset };
    const exemptions = new Exemptions();
    exemptions.close();
    const step = rateLimitStep({ enabled: true, limit: "10/min", by: ["ip", "route"] }, { store: spied, ipOf: () => "203.0.113.5", routes: patterns });
    for (const path of ["/posts/42", "/nowhere"]) {
      step.before!(new SecurityState({ request: new Request(`http://localhost${path}`), url: new URL(`http://localhost${path}`), requestId: "r", errorResponse: async () => new Response() }, exemptions, undefined));
    }
    expect(keys).toEqual(["GET /posts/[id]|203.0.113.5", "-|203.0.113.5"]);
  });

  test("another address keeps its own budget; with by ip and route, each route has its own", async () => {
    const call = await serve({ security: { rateLimit: { limit: "2/min" } } });
    expect((await call("/posts")).status).toBe(200);
    expect((await call("/tags")).status).toBe(200);
    expect((await call("/posts")).status).toBe(429);
    expect((await call("/posts", "198.51.100.1")).status).toBe(200);
    const perRoute = await serve({ security: { rateLimit: { limit: "2/min", by: ["ip", "route"] } } });
    for (const path of ["/posts", "/posts", "/tags", "/tags"]) expect((await perRoute(path)).status).toBe(200);
    expect((await perRoute("/posts")).status).toBe(429);
  });
});

describe("memory store", () => {
  test("the least recently used key is evicted at maxKeys, and idle keys go after two windows", () => {
    const store = memoryRateLimitStore({ maxKeys: 2 });
    const hit = (key: string, now = 1000) => store.hit(key, { limit: 1, windowMs: MINUTE, now });
    hit("a");
    hit("b");
    expect(hit("a").allowed).toBe(false);
    hit("c");
    expect(store.size()).toBe(2);
    // b was used least recently: it starts over, while a keeps its count.
    expect(hit("b").allowed).toBe(true);
    const idle = memoryRateLimitStore();
    idle.hit("x", { limit: 5, windowMs: MINUTE, now: 0 });
    idle.hit("y", { limit: 5, windowMs: MINUTE, now: 30_000 });
    idle.hit("z", { limit: 5, windowMs: MINUTE, now: 2 * MINUTE + 10_000 });
    expect(idle.size()).toBe(2);
    idle.hit("z", { limit: 5, windowMs: MINUTE, now: 2 * MINUTE + 31_000 });
    expect(idle.size()).toBe(1);
    store.reset("a");
    expect(hit("a").allowed).toBe(true);
  });
});

describe("refusals and headers", () => {
  test("three requests pass with the remaining budget, the fourth is refused with 429 and Retry-After", async () => {
    const call = await serve({ security: { rateLimit: { limit: "3/min" } } });
    const passed = [await call("/posts"), await call("/posts"), await call("/posts")];
    expect(passed.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(passed.map((response) => response.headers.get("ratelimit-remaining"))).toEqual(["2", "1", "0"]);
    expect(passed[0]!.headers.get("ratelimit-limit")).toBe("3");
    expect(Number(passed[0]!.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
    const refused = await call("/posts");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limitHeaders(refused).slice(0, 2)).toEqual(["3", "0"]);
    // The security headers are on the refusal too.
    expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the memory store decides without promises", async () => {
    const store = memoryRateLimitStore();
    const hit = spyOn(store, "hit");
    const exemptions = new Exemptions();
    exemptions.close();
    const step = rateLimitStep({ enabled: true, limit: "1000/min", by: ["ip"] }, { store, ipOf: () => "203.0.113.5" });
    const { request } = securityMiddlewares([step], exemptions, () => undefined);
    const server = createServer({ routes, repos: {}, config: { production: false, logger }, middleware: middlewareStages([{ owner: "security", middleware: request }]) });
    for (let index = 0; index < 5; index++) expect((await server.fetch(new Request("http://localhost/posts"))).status).toBe(200);
    expect(hit).toHaveBeenCalledTimes(5);
    for (const result of hit.mock.results) expect(result.value).not.toBeInstanceOf(Promise);
    const state = new SecurityState({ request: new Request("http://localhost/posts"), url: new URL("http://localhost/posts"), requestId: "r", errorResponse: async () => new Response() }, exemptions, undefined);
    expect(step.before!(state)).toBeUndefined();
  });
});

describe("exemptions and workers", () => {
  test("an exempted path is not counted and gets no rate limit headers", async () => {
    const exemptions = new Exemptions();
    exemptions.add("/health/*", ["rateLimit"]);
    exemptions.close();
    const step = rateLimitStep({ enabled: true, limit: "1/min", by: ["ip"] }, { store: memoryRateLimitStore(), ipOf: () => "203.0.113.5" });
    const { request } = securityMiddlewares([step], exemptions, () => undefined);
    const server = createServer({ routes, repos: {}, config: { production: false, logger }, middleware: middlewareStages([{ owner: "security", middleware: request }]) });
    const call = (path: string) => server.fetch(new Request(`http://localhost${path}`));
    for (let index = 0; index < 3; index++) {
      const health = await call("/health/live");
      expect(health.status).toBe(200);
      expect(limitHeaders(health)).toEqual([null, null, null]);
    }
    expect((await call("/posts")).status).toBe(200);
    expect((await call("/posts")).status).toBe(429);
  });

  test("several workers with the memory store log the per-worker warning once per worker", async () => {
    await serve({}, { index: 0, count: 2, runsScheduledWork: true });
    await serve({}, { index: 1, count: 2, runsScheduledWork: false });
    const warnings = logs.filter((entry) => entry.message === 'security.rateLimit uses per-worker memory counters; set security.rateLimit.store to "database" to share them');
    expect(warnings).toHaveLength(2);
    logs.length = 0;
    await serve({});
    expect(logs.filter((entry) => String(entry.message).startsWith("security.rateLimit"))).toEqual([]);
  });
});
