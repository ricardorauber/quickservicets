import { afterEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { CODES_BY_STATUS, HttpError } from "./errors.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { prepareFeatureTargets, taggedRoutes } from "./feature-targets.ts";
import { createServer, type Route } from "./http/server.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import { middlewareStages, type Middleware, type OwnedMiddleware } from "./middleware.ts";
import type { EntityModel } from "./model.ts";
import { EXEMPT, Exemptions } from "./features/security/exempt.ts";
import { securityMiddlewares, SECURITY_ITEMS, type SecurityStep } from "./features/security/pipeline.ts";
import { buildRouteIndex, routeIndexStats } from "./features/security/routes.ts";
// Loading the core registers the natives it ships.
import "./index.ts";

const logs: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
afterEach(() => {
  logs.length = 0;
  registerProjectFeatures([]);
});

const resolve = (config: Record<string, unknown> = {}, env: Record<string, string> = {}) => resolveConfig({ database: memoryAdapter(), logger, ...config } as ServiceConfig, env);
const security = (config: ReturnType<typeof resolve>) => config.features.find((feature) => feature.key === "security");

/** Runs the features' setups of a configuration and returns the middlewares they registered. */
async function setUp(config: ReturnType<typeof resolve>) {
  const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  return lifecycle;
}

const serve = (routes: Route[], entries: OwnedMiddleware[]) => createServer({ routes, repos: {}, config: { production: false, logger }, middleware: middlewareStages(entries) });
const owned = (owner: string, ...middleware: (Middleware | undefined)[]): OwnedMiddleware[] => middleware.filter((entry) => entry !== undefined).map((entry) => ({ owner, middleware: entry! }));
const call = (server: ReturnType<typeof serve>, path: string, init?: RequestInit) => server.fetch(new Request(`http://localhost${path}`, init));
const ok: Route["handler"] = () => ({ ok: true });

describe("registration and toggles", () => {
  test("security is a native on by default with every item enabled, also with security: {}", () => {
    for (const config of [resolve(), resolve({ security: {} })]) {
      const feature = security(config)!;
      expect(feature.native).toBe(true);
      expect(feature.definition.enabledByDefault).toBe(true);
      for (const item of SECURITY_ITEMS) expect((feature.options[item] as { enabled: boolean }).enabled).toBe(true);
    }
    expect(SECURITY_ITEMS).toEqual(["proxy", "headers", "files", "cors", "limits", "timeouts", "loadShedding", "rateLimit", "ip", "masking", "csrf"]);
  });

  test("security: false and QS_SECURITY_ENABLED=false remove the feature and register no middleware", async () => {
    for (const config of [resolve({ security: false }), resolve({}, { QS_SECURITY_ENABLED: "false" })]) {
      expect(security(config)).toBeUndefined();
      expect(config.disabledFeatures).toContain("security");
      const lifecycle = await setUp(config);
      expect(lifecycle.middleware.filter((entry) => entry.owner === "security")).toEqual([]);
      const response = await call(serve([{ method: "GET", path: "/posts", handler: ok }], lifecycle.middleware), "/posts");
      expect(response.headers.get("x-content-type-options")).toBeNull();
    }
  });

  test("one item is switched off by its key or its environment variable, the others stay on", () => {
    for (const config of [resolve({ security: { cors: false } }), resolve({}, { QS_SECURITY_CORS_ENABLED: "false" })]) {
      const options = security(config)!.options as Record<string, { enabled: boolean }>;
      expect(options.cors!.enabled).toBe(false);
      for (const item of SECURITY_ITEMS.filter((name) => name !== "cors")) expect(options[item]!.enabled).toBe(true);
    }
  });

  test("startup logs security.enabled with the enabled items", async () => {
    await setUp(resolve({ security: { cors: false, masking: false } }));
    const entry = logs.find((log) => log.message === "security.enabled");
    expect(entry).toMatchObject({ feature: "security", items: ["proxy", "headers", "files", "limits", "timeouts", "loadShedding", "rateLimit", "ip", "csrf"] });
  });
});

describe("item order", () => {
  const recorder = (seen: string[], names: SecurityStep["name"][]): SecurityStep[] =>
    names.map((name) => ({ name, before: () => void seen.push(name), after: (response) => (seen.push(`out:${name}`), response) }));

  test("the request stage runs the steps in their fixed order, whatever order they are given in", async () => {
    const seen: string[] = [];
    const steps = recorder(seen, ["body", "headers", "rateLimit", "cors", "ip", "limits", "loadShedding"]);
    const middlewares = securityMiddlewares(steps, new Exemptions(), () => undefined);
    expect(middlewares.request.order).toBe(-1000);
    expect(middlewares.handler).toBeUndefined();
    const response = await call(serve([{ method: "GET", path: "/posts", handler: ok }], owned("security", middlewares.request)), "/posts");
    expect(response.status).toBe(200);
    expect(seen.slice(0, 7)).toEqual(["loadShedding", "limits", "ip", "cors", "rateLimit", "body", "headers"]);
    // On the way out, the security headers, CORS and rate limit headers come first.
    expect(seen.slice(7, 10)).toEqual(["out:headers", "out:cors", "out:rateLimit"]);
  });

  test("the handler middleware exists only for steps that need it and runs inside the default-order middlewares", async () => {
    const users: unknown[] = [];
    const step: SecurityStep = { name: "rateLimit", handler: (req) => void users.push(req.user) };
    const middlewares = securityMiddlewares([step], new Exemptions(), () => undefined);
    expect(middlewares.handler?.order).toBe(1000);
    const auth: Middleware = { stage: "handler", run: (req, _res, next) => ((req.user = { id: "u1" } as never), next()) };
    // Security comes first in feature order, yet its handler middleware runs after the one setting req.user.
    const server = serve([{ method: "GET", path: "/me", handler: ok }], [...owned("security", middlewares.request, middlewares.handler), ...owned("auth", auth)]);
    expect((await call(server, "/me")).status).toBe(200);
    expect(users).toEqual([{ id: "u1" }]);
  });
});

describe("route index", () => {
  const post = { key: "Post", tags: { rateLimit: { on: true, options: { limit: "10/min" } } } } as unknown as EntityModel;
  const crud = [
    { method: "GET", path: "/posts", entity: "Post" },
    { method: "GET", path: "/posts/[id]", entity: "Post" },
  ];

  test("no index is built without security tags", () => {
    prepareFeatureTargets([{ ...post, tags: undefined } as EntityModel], [], crud);
    const before = routeIndexStats.builds;
    expect(buildRouteIndex(taggedRoutes(), ["rateLimit"])).toBeUndefined();
    expect(routeIndexStats.builds).toBe(before);
  });

  test("with one tagged entity the request stage finds that route's tags for GET /posts/42", () => {
    prepareFeatureTargets([post], [{ method: "GET", path: "/stats" }], crud);
    const before = routeIndexStats.builds;
    const index = buildRouteIndex(taggedRoutes(), ["rateLimit"])!;
    expect(routeIndexStats.builds).toBe(before + 1);
    expect(index.find("GET", "/posts/42")).toMatchObject({ method: "GET", path: "/posts/[id]", tags: { rateLimit: { on: true, options: { limit: "10/min" } } } });
    expect(index.find("GET", "/stats")).toBeUndefined();
    expect(index.find("DELETE", "/posts/42")).toBeUndefined();
  });
});

describe("exemptions", () => {
  test("exact and prefix patterns give one mask per path", () => {
    const exemptions = new Exemptions();
    exemptions.add("/health/*", ["rateLimit"]);
    exemptions.add("/metrics", ["all"]);
    exemptions.add("/health/live", ["ip"]);
    exemptions.close();
    expect(exemptions.match("/health/ready")).toBe(EXEMPT.rateLimit);
    expect(exemptions.match("/health")).toBe(EXEMPT.rateLimit);
    expect(exemptions.match("/health/live")).toBe(EXEMPT.rateLimit | EXEMPT.ip);
    expect(exemptions.match("/metrics")).toBe(63);
    expect(exemptions.match("/healthy")).toBe(0);
    expect(() => new Exemptions().add("/x", ["nope" as never])).toThrow('unknown item "nope"');
  });

  test("an exempted path passes a limit that blocks other paths, and exempt after setup throws", async () => {
    const exempted: string[] = [];
    const project = defineFeature({
      key: "probes",
      after: ["security"],
      setup(ctx) {
        ctx.feature("security").exempt("/health/*", ["rateLimit"]);
        ctx.app.onStart(() => {
          try {
            ctx.feature("security").exempt("/late", ["rateLimit"]);
          } catch (error) {
            exempted.push((error as Error).message);
          }
        });
      },
    });
    registerProjectFeatures([{ folder: "probes", definition: project }]);
    const config = resolve({ probes: {} });
    const lifecycle = await setUp(config);
    await lifecycle.start({ repos: {}, server: undefined as never });
    expect(exempted).toEqual(["security exempt() is only available during setup"]);
    // The native's exemptions, read through a step that refuses every path not exempted from rate limits.
    const exemptions = new Exemptions();
    exemptions.add("/health/*", ["rateLimit"]);
    exemptions.close();
    const limiter: SecurityStep = { name: "rateLimit", before: (state) => {
      if (!(state.exempt & EXEMPT.rateLimit)) throw new HttpError(429, "Too many requests");
    } };
    const middlewares = securityMiddlewares([limiter], exemptions, () => undefined);
    const routes: Route[] = [{ method: "GET", path: "/posts", handler: ok }, { method: "GET", path: "/health/ready", handler: ok }];
    const server = serve(routes, owned("security", middlewares.request));
    expect((await call(server, "/posts")).status).toBe(429);
    expect((await call(server, "/health/ready")).status).toBe(200);
  });
});

describe("error codes and the error stage", () => {
  test("the new statuses have their codes", () => {
    expect(CODES_BY_STATUS).toMatchObject({ 408: "REQUEST_TIMEOUT", 414: "URI_TOO_LONG", 429: "RATE_LIMITED", 431: "REQUEST_HEADER_FIELDS_TOO_LARGE", 503: "SERVICE_UNAVAILABLE" });
  });

  test("a refusal passes through the error stage, and the steps still add their headers to the changed response", async () => {
    const limiter: SecurityStep = {
      name: "rateLimit",
      before: () => {
        throw new HttpError(429, "Too many requests", { headers: { "retry-after": "7" } });
      },
      after: (response) => {
        response.headers.set("x-limited", "yes");
        return response;
      },
    };
    const middlewares = securityMiddlewares([limiter], new Exemptions(), () => undefined);
    const routes: Route[] = [{ method: "GET", path: "/posts", handler: ok }];
    const plain = await call(serve(routes, owned("security", middlewares.request)), "/posts");
    expect(plain.status).toBe(429);
    expect(plain.headers.get("retry-after")).toBe("7");
    expect(await plain.json()).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    const custom: Middleware = { stage: "error", run: (error) => (error instanceof HttpError && error.code === "RATE_LIMITED" ? Response.json({ slowDown: true }, { status: 429 }) : undefined) };
    const changed = await call(serve(routes, [...owned("security", middlewares.request), ...owned("project", custom)]), "/posts");
    expect(changed.status).toBe(429);
    expect(await changed.json()).toEqual({ slowDown: true });
    expect(changed.headers.get("x-limited")).toBe("yes");
  });
});
