import { afterEach, describe, expect, spyOn, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { testAuth } from "./features/auth/test-provider.ts";
import { requireRole, requireUser } from "./features/auth/index.ts";
import { buildRouteRules, parseRoleEntry, ruleOf } from "./features/auth/routes.ts";
import { HttpError } from "./errors.ts";
import { errorOf, startTestApp, type TestApp, type TestEndpointInput } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import type { ParsedTags } from "./model.ts";

const post = entity("Post", [field({ name: "title", type: "string" })]);
const running: TestApp[] = [];
const registered: string[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const key of registered.splice(0)) unregisterNative(key);
});

function native(key: string, setup: Parameters<typeof defineFeature>[0]["setup"], extra: Partial<Parameters<typeof defineFeature>[0]> = {}) {
  registerNative(defineFeature({ key, docs: { summary: "Test native." }, enabledByDefault: true, after: ["auth"], setup, ...extra }));
  registered.push(key);
}

async function start(config: Record<string, unknown>, endpoints: TestEndpointInput[] = [], models = [post]) {
  native("auth-roles-test", (ctx) => ctx.feature("auth").provider(testAuth()), { requires: ["auth"], after: [] });
  const app = await startTestApp({ config, models, endpoints });
  running.push(app);
  return app;
}

const tags = (value: Record<string, Record<string, unknown> | false>): ParsedTags =>
  Object.fromEntries(Object.entries(value).map(([name, options]) => [name, options === false ? { on: false, options: {} } : { on: true, options }]));
const defaults = { required: false, scopes: [], roles: [] };

describe("@roles entries", () => {
  test("roles, operations and groups parse, and unknown operations or operations on endpoints are refused", () => {
    expect(parseRoleEntry("admin", false)).toEqual({ role: "admin" });
    expect(parseRoleEntry("admin:delete", true)).toEqual({ role: "admin", operations: ["delete"] });
    expect(parseRoleEntry("viewer:view", true)).toEqual({ role: "viewer", operations: ["list", "read"] });
    expect(parseRoleEntry("editor:write", true)).toEqual({ role: "editor", operations: ["create", "update", "replace", "delete"] });
    expect(parseRoleEntry("admin:fly", true)).toBe("admin:fly: unknown operation fly; use list, read, create, update, replace, delete, view, write");
    expect(parseRoleEntry("admin:delete", false)).toBe("admin:delete: operations apply only to entities");
    expect(parseRoleEntry(":read", true)).toBe('":read" has no role');
  });
});

describe("rules", () => {
  test("entries apply to the routes of their operation, and @roles implies @auth there", () => {
    const route = (operation: "list" | "delete", value: ParsedTags) => ruleOf({ method: "GET", path: "/users", entity: "User", operation, tags: value }, defaults);
    const roles = tags({ roles: { roles: ["admin:delete", "auditor"] } });
    expect(route("delete", roles)).toMatchObject({ user: true, roles: new Set(["admin", "auditor"]) });
    expect(route("list", roles)).toMatchObject({ user: true, roles: new Set(["auditor"]) });
    expect(route("list", tags({ roles: { roles: ["admin:delete"] } }))).toMatchObject({ user: false });
    expect(route("list", tags({ roles: { roles: ["admin:delete"] }, auth: false })).user).toBe(false);
    expect(route("delete", tags({ roles: { roles: ["admin:delete"] }, auth: false })).user).toBe(true);
  });

  test("@auth and required decide the user, and scopes come from the tag or the global option", () => {
    const options = { required: true, scopes: ["api"], roles: [] };
    expect(ruleOf({ method: "GET", path: "/a" }, options)).toMatchObject({ user: true, scopes: ["api"], tagged: false });
    expect(ruleOf({ method: "GET", path: "/a", tags: tags({ auth: false }) }, options)).toMatchObject({ user: false, scopes: [] });
    expect(ruleOf({ method: "GET", path: "/a", tags: tags({ auth: { scopes: ["posts:write"] } }) }, options)).toMatchObject({ user: true, scopes: ["posts:write"] });
    expect(ruleOf({ method: "GET", path: "/a", auth: false }, options)).toMatchObject({ user: false });
    expect(ruleOf({ method: "GET", path: "/a" }, defaults)).toMatchObject({ user: false, tagged: false });
  });

  test("only routes that differ from the default are indexed; with required, the docs and public runtime routes are", () => {
    const sources = { tagged: [{ method: "GET", path: "/posts", entity: "Post", tags: tags({ auth: {} }) }, { method: "GET", path: "/open" }], runtime: [{ method: "GET", path: "/health/live", auth: false }], models: [post] };
    expect([...buildRouteRules(sources, defaults).keys()]).toEqual(["GET /posts"]);
    expect([...buildRouteRules({ ...sources, tagged: [{ method: "GET", path: "/open" }] }, defaults).keys()]).toEqual([]);
    expect([...buildRouteRules(sources, { ...defaults, required: true }).keys()].sort()).toEqual(["GET /docs", "GET /health/live", "GET /openapi.json"]);
  });
});

describe("requireUser and requireRole", () => {
  test("they return the user or throw the 401 and 403 answers", () => {
    const user = { id: "u1", roles: ["editor"], claims: {} };
    expect(requireUser({ user })).toEqual(user);
    expect(requireUser({ user: { id: "u2" } })).toEqual({ id: "u2", roles: [], claims: {} });
    expect(() => requireUser({ user: undefined })).toThrow("Authentication required");
    expect(requireRole({ user }, "admin", "editor").id).toBe("u1");
    let error: unknown;
    try {
      requireRole({ user }, "admin");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).message).toBe("Not allowed");
    expect(() => requireRole({ user: undefined }, "admin")).toThrow("Authentication required");
  });
});

describe("cost", () => {
  test("one rule lookup per request with tagged routes, and none without tags and with required false", async () => {
    const lookups = () => spy.mock.calls.filter(([key]) => typeof key === "string" && /^GET \/(posts|whoami)/.test(key)).length;
    const whoami: TestEndpointInput = { path: "/whoami", handler: () => ({}) };
    const tagged = await start({ auth: {} }, [whoami, { path: "/secret", handler: () => ({}), tags: tags({ auth: {} }) }]);
    const spy = spyOn(Map.prototype, "get");
    try {
      await tagged.fetch("/whoami");
      expect(lookups()).toBe(1);
      expect((await tagged.fetch("/secret")).status).toBe(401);
      spy.mockClear();
      for (const app of running.splice(0)) await app.stop();
      for (const key of registered.splice(0)) unregisterNative(key);
      const untagged = await start({ auth: {} }, [whoami]);
      spy.mockClear();
      expect((await untagged.fetch("/whoami")).status).toBe(200);
      expect((await untagged.fetch("/posts")).status).toBe(200);
      expect(lookups()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("runtime routes", () => {
  test("with required, the health probes and routes registered with auth: false answer anonymous requests", async () => {
    native("public-routes", (ctx) => {
      ctx.app.route("GET", "/sign-in", () => ({ form: true }), { auth: false });
      ctx.app.route("GET", "/account", () => ({ account: true }));
    });
    const app = await start({ auth: { required: true }, health: {} });
    expect((await app.fetch("/health/live")).status).toBe(200);
    expect((await app.fetch("/sign-in")).status).toBe(200);
    expect(await errorOf(await app.fetch("/account"))).toMatchObject({ status: 401, message: "Authentication required" });
    expect((await app.fetch("/account", { headers: { "x-test-user": "u1" } })).status).toBe(200);
    expect((await app.fetch("/posts")).status).toBe(401);
  });
});
