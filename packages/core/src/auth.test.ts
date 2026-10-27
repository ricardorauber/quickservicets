import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { AuthError, type AuthProvider } from "./features/auth/api.ts";
import { cookieValue } from "./cookies.ts";
import { parseTestUser, testAuth } from "./features/auth/test-provider.ts";
import { errorOf, startTestApp, type TestApp, type TestEndpointInput } from "./tenancy-test-support.ts";
import type { ServiceRequest } from "./hooks.ts";
import { entity, field } from "./testing/entities.ts";

const post = entity("Post", [field({ name: "title", type: "string" })]);
const whoami: TestEndpointInput = { path: "/whoami", handler: (_repos, req) => ({ user: req.user ?? null, auth: req.auth ?? null, tenant: req.tenant ?? null }) };

const running: TestApp[] = [];
const registered: string[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const key of registered.splice(0)) unregisterNative(key);
});

/** A test native that registers the given providers with `auth` during its setup. */
function providersFeature(key: string, providers: AuthProvider[]) {
  registerNative(defineFeature({ key, docs: { summary: "Registers test providers." }, enabledByDefault: true, requires: ["auth"], setup: (ctx) => providers.forEach((provider) => ctx.feature("auth").provider(provider)) }));
  registered.push(key);
}

async function start(providers: AuthProvider[], config: Record<string, unknown> = {}, endpoints: TestEndpointInput[] = [whoami]) {
  providersFeature("auth-test-providers", providers);
  const app = await startTestApp({ config: { auth: {}, ...config }, models: [post], endpoints });
  running.push(app);
  return app;
}

/** A provider reading one header, counting its calls; `answer` decides its result. */
function headerProvider(name: string, header: string, answer: (req: ServiceRequest) => ReturnType<AuthProvider["authenticate"]> = (req) => ({ user: { id: req.headers.get(header)! }, method: "bearer" })) {
  const calls: string[] = [];
  const provider: AuthProvider = {
    name,
    credentials: { headers: [header] },
    challenge: 'Bearer realm="api"',
    authenticate(req) {
      calls.push(req.path);
      return answer(req);
    },
  };
  return { provider, calls };
}

const body = async (response: Response) => (await response.json()) as { user: Record<string, unknown> | null; auth: Record<string, unknown> | null; tenant: { id: string } | null };

describe("provider registration", () => {
  test("providers are tried in registration order until one returns a result", async () => {
    const first = headerProvider("first", "authorization", () => null);
    const second = headerProvider("second", "authorization", () => ({ user: { id: "u2" }, method: "bearer" }));
    const app = await start([first.provider, second.provider]);
    const seen = await body(await app.fetch("/whoami", { headers: { authorization: "Bearer t" } }));
    expect(seen.user).toEqual({ id: "u2", roles: [], claims: {} });
    expect(seen.auth).toMatchObject({ provider: "second", method: "bearer" });
    expect([first.calls.length, second.calls.length]).toEqual([1, 1]);
  });

  test("registering the same name twice fails startup", async () => {
    const one = headerProvider("same", "x-a");
    const two = headerProvider("same", "x-b");
    await expect(start([one.provider, two.provider])).rejects.toThrow("Auth provider same is registered twice");
  });

  test("providers cannot be registered once the service started", async () => {
    let api: { provider(p: AuthProvider): void } | undefined;
    registerNative(defineFeature({ key: "late-provider", docs: { summary: "Keeps the API." }, enabledByDefault: true, after: ["auth"], setup: (ctx) => void (api = ctx.feature("auth")) }));
    registered.push("late-provider");
    await start([]);
    expect(() => api!.provider(headerProvider("late", "x-late").provider)).toThrow("auth provider() is only available during setup");
  });
});

describe("credential detection", () => {
  test("each provider is called only when its header is present, and a request without credentials calls none", async () => {
    const a = headerProvider("a", "x-a");
    const b = headerProvider("b", "x-b");
    const app = await start([a.provider, b.provider]);
    expect((await body(await app.fetch("/whoami"))).user).toBeNull();
    expect([a.calls.length, b.calls.length]).toEqual([0, 0]);
    expect((await body(await app.fetch("/whoami", { headers: { "x-b": "bea" } }))).user).toMatchObject({ id: "bea" });
    expect([a.calls.length, b.calls.length]).toEqual([0, 1]);
    expect((await body(await app.fetch("/whoami", { headers: { "x-a": "ana" } }))).user).toMatchObject({ id: "ana" });
    expect([a.calls.length, b.calls.length]).toEqual([1, 1]);
  });

  test("cookies and query parameters are credentials too", async () => {
    const calls: string[] = [];
    const cookie: AuthProvider = { name: "cookie", credentials: { cookies: ["sid"] }, authenticate: (req) => (calls.push("cookie"), { user: { id: cookieValue(req.headers.get("cookie")!, "sid")! }, method: "cookie" }) };
    const query: AuthProvider = { name: "query", credentials: { query: ["token"] }, authenticate: (req) => (calls.push("query"), { user: { id: req.query.get("token")! }, method: "apiKey" }) };
    const app = await start([cookie, query]);
    expect((await body(await app.fetch("/whoami", { headers: { cookie: "theme=dark" } }))).user).toBeNull();
    expect(calls).toEqual([]);
    expect((await body(await app.fetch("/whoami", { headers: { cookie: "theme=dark; sid=s-1" } }))).auth).toMatchObject({ method: "cookie" });
    expect((await body(await app.fetch("/whoami?token=k-1"))).user).toMatchObject({ id: "k-1" });
    expect(calls).toEqual(["cookie", "query"]);
    expect(cookieValue("a=1; b = 2", "b")).toBe("2");
  });
});

describe("results", () => {
  test("a result fills req.user with defaults, req.auth and req.tenant", async () => {
    const expiresAt = new Date("2030-01-01T00:00:00Z");
    const full = headerProvider("full", "authorization", () => ({
      user: { id: "u1", roles: ["admin"], email: "ana@example.com", name: "Ana", claims: { sub: "u1" } },
      tenant: { id: "acme" },
      method: "bearer",
      sessionId: "s1",
      expiresAt,
      scopes: ["posts:read"],
    }));
    const app = await start([full.provider]);
    const seen = await body(await app.fetch("/whoami", { headers: { authorization: "Bearer t" } }));
    expect(seen.user).toEqual({ id: "u1", roles: ["admin"], email: "ana@example.com", name: "Ana", claims: { sub: "u1" } });
    expect(seen.auth).toEqual({ provider: "full", method: "bearer", sessionId: "s1", expiresAt: expiresAt.toISOString(), scopes: ["posts:read"] });
    expect(seen.tenant).toEqual({ id: "acme" });
  });

  test("with tenancy, a tenant from the credentials refuses a request for another tenant", async () => {
    const app = await start([testAuth()], { tenancy: { source: "config", tenants: { acme: {}, globex: {} } } });
    const refused = await app.fetch("/whoami", { headers: { "x-test-user": "u1;tenant=acme", "x-tenant-id": "globex" } });
    expect(await errorOf(refused)).toEqual({ status: 403, code: "TENANT_MISMATCH", message: "Tenant does not match the credentials" });
    const allowed = await body(await app.fetch("/whoami", { headers: { "x-test-user": "u1;tenant=acme", "x-tenant-id": "acme" } }));
    expect(allowed.tenant).toMatchObject({ id: "acme" });
  });
});

describe("failures", () => {
  test("an AuthError answers 401 with the challenges on every route and logs auth.failed without the token", async () => {
    const expired = headerProvider("jwt", "authorization", () => {
      throw new AuthError("expired");
    });
    const app = await start([expired.provider]);
    for (const path of ["/posts", "/whoami"]) {
      const response = await app.fetch(path, { headers: { authorization: "Bearer secret-token" } });
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="api", error="invalid_token"');
      expect(await errorOf(response)).toEqual({ status: 401, code: "UNAUTHORIZED", message: "Invalid credentials" });
    }
    const failed = app.logs.filter((entry) => entry.message === "auth.failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ level: "info", provider: "jwt", reason: "expired", ip: "unknown" });
    expect(JSON.stringify(app.logs)).not.toContain("secret-token");
  });

  test("any other provider error answers 500 and logs auth.provider.failed", async () => {
    const broken = headerProvider("broken", "authorization", () => {
      throw new TypeError("boom");
    });
    const app = await start([broken.provider]);
    const response = await app.fetch("/posts", { headers: { authorization: "Bearer t" } });
    expect(response.status).toBe(500);
    expect(app.logs.find((entry) => entry.message === "auth.provider.failed")).toMatchObject({ level: "error", provider: "broken", error: { message: "boom" } });
  });

  test("a non-bearer challenge is sent as it is", async () => {
    const basic: AuthProvider = { name: "basic", credentials: { headers: ["authorization"] }, challenge: 'Basic realm="api"', authenticate: () => { throw new AuthError("bad password"); } };
    const app = await start([basic]);
    const response = await app.fetch("/posts", { headers: { authorization: "Basic eA==" } });
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="api"');
  });
});

describe("testAuth()", () => {
  test("x-test-user gives the user, roles, tenant and session with the method test", async () => {
    expect(parseTestUser("u1;roles=admin,editor;tenant=acme;session=s1")).toEqual({ user: { id: "u1", roles: ["admin", "editor"] }, tenant: { id: "acme" }, sessionId: "s1", method: "test" });
    expect(() => parseTestUser("")).toThrow(AuthError);
    expect(() => parseTestUser("u1;color=red")).toThrow("unknown test user part color");
    const app = await start([testAuth()]);
    const seen = await body(await app.fetch("/whoami", { headers: { "x-test-user": "u1;roles=admin" } }));
    expect(seen.user).toEqual({ id: "u1", roles: ["admin"], claims: {} });
    expect(seen.auth).toMatchObject({ provider: "test", method: "test" });
    expect((await body(await app.fetch("/whoami"))).user).toBeNull();
  });

  test("testAuth() cannot run in production", async () => {
    await expect(start([testAuth()], { production: true })).rejects.toThrow("testAuth() cannot run in production");
  });
});

describe("without auth", () => {
  test("no auth middleware is registered", async () => {
    const app = await startTestApp({ models: [post], endpoints: [whoami] });
    running.push(app);
    expect(app.lifecycle.middleware.some((entry) => entry.owner === "auth")).toBe(false);
    expect(app.config.features.some((feature) => feature.key === "auth")).toBe(false);
  });
});
