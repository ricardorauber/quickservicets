import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import type { AuthProvider } from "./features/auth/api.ts";
import { testAuth } from "./features/auth/test-provider.ts";
import { errorOf, startTestApp, type TestApp, type TestEndpointInput } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import type { ParsedTags } from "./model.ts";

const roles = (entries: string[]): ParsedTags => ({ roles: { on: true, options: { roles: entries } } });
const post = entity("Post", [field({ name: "title", type: "string" })], { tags: roles(["editor:write"]) });
const editor = entity("Editor", [field({ name: "userId", type: "string" })]);
const whoami: TestEndpointInput = { path: "/whoami", handler: (_repos, req) => ({ user: req.user ?? null }) };

const running: TestApp[] = [];
const registered: string[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const key of registered.splice(0)) unregisterNative(key);
});

async function start(auth: Record<string, unknown>, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const app = await startTestApp({ config: { auth: { providers: [testAuth()], ...auth }, ...extra }, models: [post, editor], endpoints: [whoami], env });
  running.push(app);
  return app;
}

const json = (user: string | undefined, method = "POST", body: unknown = { title: "Hi" }): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
  ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body) }),
});

describe("variables and the per-request required", () => {
  test("auth: {} with a provider serves public routes, QS_AUTH_REQUIRED=true makes them answer 401, and every option has its variable", async () => {
    expect((await (await start({})).fetch("/whoami")).status).toBe(200);
    const required = await start({}, {}, { QS_AUTH_REQUIRED: "true" });
    expect(await errorOf(await required.fetch("/whoami"))).toMatchObject({ status: 401, message: "Authentication required" });
    const options = resolveConfig({ database: memoryAdapter(), auth: {} } as ServiceConfig, { QS_AUTH_SCOPES: "a,b", QS_AUTH_ROLES: "staff", QS_AUTH_ENABLED: "true" }).features.find((feature) => feature.key === "auth")!.options;
    expect(options).toMatchObject({ scopes: ["a", "b"], roles: ["staff"], enabled: true });
    expect(resolveConfig({ database: memoryAdapter(), auth: {} } as ServiceConfig, { QS_AUTH_ENABLED: "false" }).features.some((feature) => feature.key === "auth")).toBe(false);
  });

  test("a required function by tenant makes a private tenant's API answer 401 and keeps another's public", async () => {
    const tenancy = { source: "config", tenants: { acme: { attributes: { private: "true" } }, globex: {} } };
    const app = await start({ required: ({ tenant }: { tenant?: { attributes: Record<string, string> } }) => tenant?.attributes.private === "true" }, { tenancy });
    expect((await app.fetch("/whoami", { headers: { "x-tenant-id": "acme" } })).status).toBe(401);
    expect((await app.fetch("/whoami", { headers: { "x-tenant-id": "acme", "x-test-user": "u1" } })).status).toBe(200);
    expect((await app.fetch("/whoami", { headers: { "x-tenant-id": "globex" } })).status).toBe(200);
  });
});

describe("hooks", () => {
  test("beforeUser adds roles from a repository, beforeAuthorize refuses deletes, and a throwing onAuthenticated is logged", async () => {
    const seen: string[] = [];
    const app = await start({
      beforeUser: async ({ user }: { user: { id: string } }) => {
        const repos = running[running.length - 1]!.app.repos as unknown as Record<string, { findOne: (where: unknown[]) => Promise<unknown> }>;
        const isEditor = await repos.editors!.findOne([{ field: "userId", op: "eq", value: user.id }]);
        return isEditor ? { ...user, roles: ["editor"] } : undefined;
      },
      beforeAuthorize: ({ operation }: { operation?: string }) => (operation === "delete" ? false : undefined),
      onAuthenticated: () => {
        throw new Error("audit down");
      },
      onAuthFailed: ({ reason }: { reason: string }) => void seen.push(reason),
    });
    await (app.app.repos as unknown as Record<string, { create: (data: unknown) => Promise<unknown> }>).editors!.create({ userId: "ed" });
    expect((await app.fetch("/posts", json("reader"))).status).toBe(403);
    const created = await app.fetch("/posts", json("ed"));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(await errorOf(await app.fetch(`/posts/${id}`, json("ed", "DELETE")))).toMatchObject({ status: 403, message: "Not allowed" });
    expect(app.logs.find((entry) => entry.message === "feature.hook.failed")).toMatchObject({ feature: "auth", hook: "onAuthenticated", error: { message: "audit down" } });
    expect((await app.fetch(`/posts`, json(undefined))).status).toBe(401);
    expect(seen).toEqual(["missing credentials"]);
  });

  test("a feature adds hooks through addHook, and a throwing beforeUser answers with its error", async () => {
    registerNative(
      defineFeature({
        key: "hook-adder",
        docs: { summary: "Adds auth hooks." },
        enabledByDefault: true,
        after: ["auth"],
        setup(ctx) {
          ctx.feature("auth").addHook("beforeUser", (step) => {
            if ((step as { user: { id: string } }).user.id === "banned") throw Object.assign(new Error("Banned"), { name: "Banned" });
            return undefined;
          });
        },
      }),
    );
    registered.push("hook-adder");
    const app = await start({});
    expect((await app.fetch("/whoami", { headers: { "x-test-user": "banned" } })).status).toBe(500);
    expect((await app.fetch("/whoami", { headers: { "x-test-user": "ok" } })).status).toBe(200);
  });
});

describe("project providers", () => {
  test("providers of the config run before the providers features register", async () => {
    const make = (name: string): AuthProvider => ({ name, credentials: { headers: ["x-key"] }, authenticate: () => ({ user: { id: name }, method: "apiKey" }) });
    registerNative(defineFeature({ key: "feature-provider", docs: { summary: "Registers a provider." }, enabledByDefault: true, requires: ["auth"], setup: (ctx) => ctx.feature("auth").provider(make("from-feature")) }));
    registered.push("feature-provider");
    const app = await startTestApp({ config: { auth: { providers: [make("from-project")] } }, endpoints: [whoami] });
    running.push(app);
    expect(await (await app.fetch("/whoami", { headers: { "x-key": "k" } })).json()).toMatchObject({ user: { id: "from-project" } });
    expect(() => resolveConfig({ database: memoryAdapter(), auth: { providers: [{ name: "broken" }] } } as unknown as ServiceConfig, {})).toThrow("auth.providers");
  });
});
