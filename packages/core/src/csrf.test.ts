import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { cookieValue, sessionCookie } from "./cookies.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import type { AuthProvider } from "./features/auth/api.ts";
import { normalizeOrigin } from "./features/security/csrf.ts";
import { errorOf, startTestApp, type TestApp, type TestEndpointInput } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

const post = entity("Post", [field({ name: "title", type: "string" })]);
const running: TestApp[] = [];
const registered: string[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const key of registered.splice(0)) unregisterNative(key);
});

/** Signs in by the `sid` cookie (method cookie) or a bearer token (method bearer). */
const providers: AuthProvider[] = [
  { name: "session", credentials: { cookies: ["sid"] }, authenticate: (req) => ({ user: { id: cookieValue(req.headers.get("cookie")!, "sid")! }, method: "cookie" }) },
  { name: "token", credentials: { headers: ["authorization"] }, authenticate: () => ({ user: { id: "t1" }, method: "bearer" }) },
];

const beacon: TestEndpointInput = { method: "POST", path: "/beacon", handler: () => ({ ok: true }), tags: { csrf: { on: false, options: {} } } };

async function start(config: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  registerNative(defineFeature({ key: "csrf-test-providers", docs: { summary: "Registers providers." }, enabledByDefault: true, requires: ["auth"], setup: (ctx) => providers.forEach((p) => ctx.feature("auth").provider(p)) }));
  registered.push("csrf-test-providers");
  const app = await startTestApp({ config: { auth: {}, ...config }, models: [post], endpoints: [beacon], env });
  running.push(app);
  return app;
}

const write = (headers: Record<string, string>, path = "/posts") => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ title: "Hi" }), path });
const send = (app: TestApp, init: ReturnType<typeof write>, peer?: string) =>
  app.app.server.fetch(new Request(`http://localhost${init.path}`, init), peer === undefined ? undefined : { peer });

describe("origin mode", () => {
  test("a cookie write from another origin is refused, and the service's own origin or same-origin fetch metadata passes", async () => {
    const app = await start();
    const refused = await send(app, write({ cookie: "sid=u1", origin: "https://evil.example" }));
    expect(await errorOf(refused)).toEqual({ status: 403, code: "CSRF_REJECTED", message: "Cross-site request rejected" });
    expect((await send(app, write({ cookie: "sid=u1", origin: "http://localhost" }))).status).toBe(201);
    expect((await send(app, write({ cookie: "sid=u1", "sec-fetch-site": "same-origin", origin: "https://evil.example" }))).status).toBe(201);
    expect((await send(app, write({ cookie: "sid=u1", referer: "http://localhost/page" }))).status).toBe(201);
    expect(app.logs.find((entry) => entry.message === "security.csrf.rejected")).toMatchObject({ route: "POST /posts", origin: "https://evil.example" });
  });

  test("bearer requests and cookie reads from another origin pass", async () => {
    const app = await start();
    expect((await send(app, write({ authorization: "Bearer t", origin: "https://evil.example" }))).status).toBe(201);
    expect((await app.fetch("/posts", { headers: { cookie: "sid=u1", origin: "https://evil.example" } })).status).toBe(200);
    expect((await send(app, write({ origin: "https://evil.example" }))).status).toBe(201);
  });

  test("allowed origins pass, and a cookie write without Origin or Referer is refused", async () => {
    const app = await start({ security: { csrf: { origins: ["https://app.example.com"] }, cors: { origins: ["https://*.partner.example"] } } });
    expect((await send(app, write({ cookie: "sid=u1", origin: "https://app.example.com" }))).status).toBe(201);
    expect((await send(app, write({ cookie: "sid=u1", origin: "https://eu.partner.example" }))).status).toBe(201);
    expect((await send(app, write({ cookie: "sid=u1" }))).status).toBe(403);
  });

  test("x-forwarded-proto and x-forwarded-host give the own origin only behind a trusted proxy", async () => {
    const app = await start({ security: { proxy: { trust: ["10.0.0.0/8"] } } });
    const forwarded = { cookie: "sid=u1", origin: "https://api.example.com", "x-forwarded-proto": "https", "x-forwarded-host": "api.example.com" };
    expect((await send(app, write(forwarded), "10.1.2.3")).status).toBe(201);
    expect((await send(app, write(forwarded), "203.0.113.9")).status).toBe(403);
    expect(normalizeOrigin("HTTPS://Api.Example.com:443/x")).toBe("https://api.example.com");
  });
});

describe("token mode", () => {
  test("a cookie GET sets the token cookie, and a write passes only with a matching header", async () => {
    const app = await start({ security: { csrf: { mode: "token" } } });
    const read = await app.fetch("/posts", { headers: { cookie: "sid=u1" } });
    const setCookie = read.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^qs_csrf=[A-Za-z0-9_-]{43}; Path=\/; SameSite=Strict$/);
    const token = setCookie.slice("qs_csrf=".length, setCookie.indexOf(";"));
    expect((await app.fetch("/posts", { headers: { cookie: `sid=u1; qs_csrf=${token}` } })).headers.get("set-cookie")).toBeNull();
    expect((await send(app, write({ cookie: `sid=u1; qs_csrf=${token}`, "x-csrf-token": token }))).status).toBe(201);
    expect((await send(app, write({ cookie: `sid=u1; qs_csrf=${token}` }))).status).toBe(403);
    expect((await send(app, write({ cookie: `sid=u1; qs_csrf=${token}`, "x-csrf-token": "other" }))).status).toBe(403);
  });
});

describe("tag, cookie helper and disabled item", () => {
  test("@csrf off accepts a cross-site cookie write on that route only", async () => {
    const app = await start();
    expect((await send(app, write({ cookie: "sid=u1", origin: "https://evil.example" }, "/beacon"))).status).toBe(200);
    expect((await send(app, write({ cookie: "sid=u1", origin: "https://evil.example" }))).status).toBe(403);
  });

  test("sessionCookie gives HttpOnly, Path, SameSite and Max-Age, and Secure in production", () => {
    resolveConfig({ database: memoryAdapter() } as ServiceConfig, {});
    expect(sessionCookie("sid", "v", { maxAge: 3600 })).toBe("sid=v; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600");
    resolveConfig({ database: memoryAdapter(), production: true } as ServiceConfig, {});
    expect(sessionCookie("sid", "v", { maxAge: 3600 })).toBe("sid=v; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600; Secure");
    resolveConfig({ database: memoryAdapter() } as ServiceConfig, {});
    expect(sessionCookie("sid", "v", { maxAge: 60, sameSite: "Strict", path: "/app" })).toBe("sid=v; HttpOnly; Path=/app; SameSite=Strict; Max-Age=60");
  });

  test("QS_SECURITY_CSRF_ENABLED=false registers no CSRF middleware, and neither does a service without auth", async () => {
    const off = await start({}, { QS_SECURITY_CSRF_ENABLED: "false" });
    const orders = (app: TestApp) => app.lifecycle.middleware.filter((entry) => entry.owner === "security").map((entry) => entry.middleware.order);
    expect(orders(off)).not.toContain(150);
    expect((await send(off, write({ cookie: "sid=u1", origin: "https://evil.example" }))).status).toBe(201);
    for (const app of running.splice(0)) await app.stop();
    for (const key of registered.splice(0)) unregisterNative(key);
    const on = await start();
    expect(orders(on)).toContain(150);
    for (const key of registered.splice(0)) unregisterNative(key);
    const plain = await startTestApp({ models: [post] });
    running.push(plain);
    expect(orders(plain)).not.toContain(150);
  });
});
