import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "./app.ts";
import { resolveConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { definePreHook, type ServiceRequest } from "./hooks.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { withHooks } from "./http/pipeline.ts";
import { createServer, type Endpoint, type Route } from "./http/server.ts";
import type { LogEntry } from "./logger.ts";
import { middlewareStages, type Middleware } from "./middleware.ts";
import { resolveOption } from "./options.ts";

const logs: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
afterEach(() => {
  logs.length = 0;
});

const serve = (routes: Route[], middleware: Middleware[] = [], requestProperties?: Map<string, (req: ServiceRequest) => unknown>) =>
  createServer({ routes, repos: {}, config: { production: false, logger }, middleware: middlewareStages(middleware.map((entry) => ({ owner: "test", middleware: entry }))), requestProperties });
const call = (server: ReturnType<typeof serve>, path: string, method = "GET") => server.fetch(new Request(`http://localhost${path}`, { method }));

describe("request stage", () => {
  test("runs before routing, also for unmatched paths, and may answer without calling next", async () => {
    let handled = 0;
    const server = serve(
      [{ method: "GET", path: "/items", handler: () => (handled++, { ok: true }) }],
      [{ stage: "request", run: (ctx, next) => (ctx.request.method === "OPTIONS" ? new Response(null, { status: 204 }) : next()) }],
    );
    expect((await call(server, "/nowhere", "OPTIONS")).status).toBe(204);
    expect((await call(server, "/items", "OPTIONS")).status).toBe(204);
    expect(handled).toBe(0);
    expect(await (await call(server, "/items")).json()).toEqual({ ok: true });
  });

  test("a middleware adding a response header adds it to 404 responses too", async () => {
    const server = serve([], [{ stage: "request", run: async (ctx, next) => {
      const response = await next();
      response.headers.set("x-served-by", `quickservice ${ctx.url.pathname} ${ctx.requestId.length > 0}`);
      return response;
    } }]);
    const response = await call(server, "/missing");
    expect(response.status).toBe(404);
    expect(response.headers.get("x-served-by")).toBe("quickservice /missing true");
  });
});

describe("handler stage", () => {
  test("wraps the hooks and the handler, sets typed slots and may short-circuit", async () => {
    const seen: unknown[] = [];
    const hooks = new Map([["check", definePreHook((_repos, req) => void seen.push(["hook", req.user]))]]);
    const handler: Endpoint = (_repos, req) => (seen.push(["handler", req.user, req.tenant, req.flags]), { ok: true });
    const server = serve(
      [{ method: "GET", path: "/me", handler: withHooks(handler, [{ name: "check", args: [] }], hooks) }],
      [{ stage: "handler", run: (req, _res, next) => {
        if (req.headers.get("authorization") === null) throw new HttpError(401, "Sign in");
        req.user = { id: "u1" } as never;
        return next();
      } }],
    );
    const denied = await server.fetch(new Request("http://localhost/me"));
    expect([denied.status, ((await denied.json()) as { error: { message: string } }).error.message]).toEqual([401, "Sign in"]);
    expect(seen).toEqual([]);
    expect((await server.fetch(new Request("http://localhost/me", { headers: { authorization: "Bearer x" } }))).status).toBe(200);
    expect(seen).toEqual([["hook", { id: "u1" }], ["handler", { id: "u1" }, undefined, undefined]]);
  });

  test("a handler middleware may return a result without calling next", async () => {
    let handled = false;
    const server = serve([{ method: "GET", path: "/cached", handler: () => ((handled = true), { fresh: true }) }], [{ stage: "handler", run: () => ({ cached: true }) }]);
    expect(await (await call(server, "/cached")).json()).toEqual({ cached: true });
    expect(handled).toBe(false);
  });
});

describe("error stage", () => {
  class Conflict extends Error {}
  const failing: Route[] = [
    { method: "GET", path: "/conflict", handler: () => { throw new Conflict("taken"); } },
    { method: "GET", path: "/crash", handler: () => { throw new Error("boom"); } },
  ];

  test("the first middleware returning a response decides it; 500s are still logged with their stack", async () => {
    const calls: string[] = [];
    const server = serve(failing, [
      { stage: "error", run: (error, ctx) => (calls.push(`first ${ctx.req?.route}`), error instanceof Conflict ? Response.json({ conflict: true }, { status: 409 }) : undefined) },
      { stage: "error", run: () => (calls.push("second"), undefined) },
    ]);
    const conflict = await call(server, "/conflict");
    expect([conflict.status, await conflict.json()]).toEqual([409, { conflict: true }]);
    expect(calls).toEqual(["first /conflict"]);
    expect(logs.find((entry) => (entry.error as { message?: string } | undefined)?.message === "taken")).toBeDefined();
    const crash = await call(server, "/crash");
    expect(crash.status).toBe(500);
    expect((logs.find((entry) => (entry.error as { message?: string } | undefined)?.message === "boom")!.error as { stack: string }).stack).toContain("boom");
  });

  test("an error middleware that throws is logged and the default response is used", async () => {
    const server = serve(failing, [{ stage: "error", run: () => { throw new Error("mapper broke"); } }]);
    const response = await call(server, "/conflict");
    expect(response.status).toBe(500);
    expect(logs.some((entry) => entry.message === "middleware.error" && (entry.error as { message: string }).message === "mapper broke")).toBe(true);
    const missing = await call(server, "/nowhere");
    expect(missing.status).toBe(404);
  });
});

describe("ordering", () => {
  const registered: string[] = [];
  afterEach(() => {
    for (const key of registered.splice(0)) unregisterNative(key);
  });
  const tracing = (name: string, order?: number): Middleware => ({ stage: "handler", ...(order !== undefined ? { order } : {}), run: async (req, _res, next) => {
    (req.context.trail as string[]).push(name);
    return next();
  } });

  test("features in order, then by order ascending, with the project's last", async () => {
    registerNative(defineFeature({ key: "a", middleware: [tracing("a", 0)] }));
    registerNative(defineFeature({ key: "b", middleware: [tracing("b", -1)] }));
    registered.push("a", "b");
    const config = resolveConfig({ database: memoryAdapter(), logger, a: {}, b: {}, middleware: [tracing("project", -5), { stage: "request", run: (_ctx: unknown, next: () => Promise<Response>) => next() }] } as never, {});
    const handler: Endpoint = (_repos, req) => ({ trail: req.context.trail });
    const first: Middleware = { stage: "handler", order: -10, run: (req, _res, next) => ((req.context as Record<string, unknown>).trail = [], next()) };
    const app = createApp({ models: [], crudRoutes: [], endpoints: [{ method: "GET", path: "/trail", hooks: [], handler }], hooks: new Map(), config, middleware: [{ owner: "a", middleware: first }] });
    expect(await (await app.server.fetch(new Request("http://localhost/trail"))).json()).toEqual({ trail: ["b", "a", "project"] });
  });
});

describe("no middleware", () => {
  test("the handler is called straight from the server, without middleware frames", async () => {
    let stack = "";
    const server = createServer({ routes: [{ method: "GET", path: "/plain", handler: () => ((stack = new Error().stack ?? ""), { ok: true }) }], repos: {}, config: { production: false, logger } });
    expect((await server.fetch(new Request("http://localhost/plain"))).status).toBe(200);
    expect(stack).not.toContain("middleware.ts");
    expect(stack).not.toContain("compose");
  });
});

describe("request properties", () => {
  test("are computed on first read, kept for the request, and never computed when unread", async () => {
    let created = 0;
    const greeter = (req: ServiceRequest) => (created++, { greet: (name: string) => `Hello, ${name} (${req.method})` });
    const read = serve([{ method: "GET", path: "/hello", handler: (_repos, req) => {
      const example = (req as unknown as { example: ReturnType<typeof greeter> }).example;
      return { first: example.greet("Ana"), same: example === (req as unknown as { example: unknown }).example };
    } }, { method: "GET", path: "/quiet", handler: () => ({ ok: true }) }], [], new Map([["example", greeter]]));
    expect(await (await call(read, "/hello")).json()).toEqual({ first: "Hello, Ana (GET)", same: true });
    expect(created).toBe(1);
    await call(read, "/quiet");
    expect(created).toBe(1);
  });

  test("a property named like a built-in request property or another feature's fails startup", () => {
    registerNative(defineFeature({ key: "ex", request: { params: () => 1 } }));
    try {
      const config = resolveConfig({ database: memoryAdapter(), ex: {} } as never, {});
      expect(() => createApp({ models: [], crudRoutes: [], endpoints: [], hooks: new Map(), config })).toThrow("Request property params of ex conflicts with the built-in request property params");
    } finally {
      unregisterNative("ex");
    }
    registerNative(defineFeature({ key: "one", request: { clock: () => 1 } }));
    registerNative(defineFeature({ key: "two", request: { clock: () => 2 } }));
    try {
      const config = resolveConfig({ database: memoryAdapter(), one: {}, two: {} } as never, {});
      expect(() => createApp({ models: [], crudRoutes: [], endpoints: [], hooks: new Map(), config })).toThrow("Request property clock of two conflicts with one");
    } finally {
      unregisterNative("one");
      unregisterNative("two");
    }
  });
});

describe("route and per-request context", () => {
  test("req.route is the matched pattern and per-request options receive the user and tenant", async () => {
    const options = { beta: (ctx: { user?: { id?: string } }) => ctx.user?.id === "u1" };
    const server = serve([{ method: "GET", path: "/users/[id]", handler: async (_repos, req) => {
      req.user = { id: "u1" } as never;
      return { route: req.route, beta: await resolveOption(options.beta as never, { req }) };
    } }]);
    expect(await (await call(server, "/users/42")).json()).toEqual({ route: "/users/[id]", beta: true });
    expect(await resolveOption<unknown[]>(((ctx: { user?: unknown; tenant?: unknown }) => [ctx.user, ctx.tenant]) as never, { req: undefined })).toEqual([undefined, undefined]);
  });
});
