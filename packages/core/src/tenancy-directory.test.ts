import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { http } from "./features/http/index.ts";
import { cachedDirectory, configDirectory, directoryClock, tenantEntity, tenantInfoOf, type TenantDirectory, type TenantInfo } from "./features/tenancy/directory.ts";
import type { HttpMock } from "./features/http/index.ts";
import { errorOf, startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

const post = entity("Post", [field({ name: "title", type: "string" })]);
const whoami = { path: "/whoami", handler: (_repos: unknown, req: { tenant?: unknown }) => ({ tenant: req.tenant ?? null }) };

const running: TestApp[] = [];
const cleanups: (() => void)[] = [];
let mock: HttpMock | undefined;
const realNow = directoryClock.now;
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
  mock?.restore();
  mock = undefined;
  directoryClock.now = realNow;
});

async function start(tenancy: Record<string, unknown>, extra: Record<string, unknown> = {}, models = [post]) {
  const app = await startTestApp({ config: { tenancy, ...extra }, models, endpoints: [whoami as never] });
  running.push(app);
  return app;
}
const tenantOf = async (response: Response) => ((await response.json()) as { tenant: unknown }).tenant;
const as = (tenant: string) => ({ headers: { "x-tenant-id": tenant } });

describe("options and tenants", () => {
  test("the cache and source options have their defaults, and the service source needs a service", () => {
    const options = resolveConfig({ database: memoryAdapter(), tenancy: {} } as ServiceConfig, {}).features.find((feature) => feature.key === "tenancy")!.options;
    expect(options).toMatchObject({ source: "database", tenants: {}, cache: { ttl: "5m", negativeTtl: "30s", staleTtl: "1h", maxEntries: 10000 } });
    expect(() => resolveConfig({ database: memoryAdapter(), tenancy: { source: "service" } } as ServiceConfig, {})).toThrow('tenancy.service is required when tenancy.source is "service"');
    expect(() => resolveConfig({ database: memoryAdapter(), tenancy: { source: "nope" } } as unknown as ServiceConfig, {})).toThrow();
  });

  test("tenants are read into TenantInfo, refusing shapes that are not tenants", () => {
    expect(tenantInfoOf("acme", { plan: "pro", attributes: { seats: 5 } })).toEqual({ id: "acme", plan: "pro", status: "active", attributes: { seats: "5" } });
    expect(() => tenantInfoOf("acme", { status: "gone" })).toThrow("Invalid tenant acme: status must be active or suspended");
    expect(() => tenantInfoOf("acme", { strategy: "cluster" })).toThrow("Invalid tenant acme: strategy must be schema or database");
  });

  test("the config source: active tenants resolve with their plan, suspended ones answer 403 and unknown ones 404", async () => {
    const app = await start({ source: "config", tenants: { acme: { plan: "pro" }, old: { status: "suspended" } } });
    expect(await tenantOf(await app.fetch("/whoami", as("acme")))).toEqual({ id: "acme", plan: "pro", attributes: {} });
    expect(await errorOf(await app.fetch("/whoami", as("old")))).toEqual({ status: 403, code: "TENANT_SUSPENDED", message: "Tenant is suspended" });
    expect(await errorOf(await app.fetch("/whoami", as("nope")))).toEqual({ status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" });
  });
});

describe("the database source", () => {
  test("contributes the Tenant entity, internal and shared; starting without it fails", async () => {
    const native = (await import("./features/tenancy/index.ts")).default;
    const entities = native.entities as unknown as (context: { models: []; options: Record<string, unknown> }) => { key: string; internal: boolean }[];
    expect(entities({ models: [], options: { source: "database" } }).map((model) => [model.key, model.internal])).toEqual([["Tenant", true]]);
    expect(entities({ models: [], options: { source: "config" } })).toEqual([]);
    expect(tenantEntity().fields.find((item) => item.name === "connection")).toMatchObject({ hidden: true, tags: { sensitive: { on: true } } });
    const failure = await startTestApp({ config: { tenancy: { source: "config" } }, env: { QS_TENANCY_SOURCE: "database" }, models: [post] }).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toBe('tenancy failed in setup: tenancy.source is "database" but the Tenant entity is missing; rebuild and run quickservicets migration add');
  });

  test("a Tenant row resolves its tenant", async () => {
    const tenant = tenantEntity();
    const app = await start({}, {}, [post, tenant]);
    await app.database.insert(tenant, { id: Bun.randomUUIDv7(), createdAt: new Date(), updatedAt: new Date(), key: "acme", status: "active", plan: "free" });
    expect(await tenantOf(await app.fetch("/whoami", as("acme")))).toEqual({ id: "acme", plan: "free", attributes: {} });
  });
});

describe("the service source", () => {
  test("GET /tenants/<id> answers tenants and 404s, concurrent lookups make one call, and list() follows the pages", async () => {
    mock = http.mock();
    let calls = 0;
    mock.service("directory" as never).on("GET", "/tenants/acme").replyWith(async () => {
      calls++;
      await Bun.sleep(5);
      return { status: 200, body: { id: "acme", plan: "pro" } };
    });
    mock.service("directory" as never).on("GET", "/tenants/nope").reply(404, { error: "none" });
    mock.service("directory" as never).on("GET", "/tenants").reply(200, { data: [{ id: "acme" }, { id: "globex" }], next: "p2" });
    mock.service("directory" as never).on("GET", "/tenants?cursor=p2").reply(200, { data: [{ id: "initech", status: "suspended" }] });
    const seen: string[] = [];
    registerNative(
      defineFeature({
        key: "test-tenants",
        docs: { summary: "Test." },
        after: ["tenancy"],
        setup(ctx) {
          ctx.app.onStart(async () => {
            for await (const tenant of ctx.feature("tenancy").list()) seen.push(`${tenant.id}:${tenant.status}`);
          });
        },
      }),
    );
    cleanups.push(() => unregisterNative("test-tenants"));
    const app = await start({ source: "service", service: "directory" }, { http: { services: { directory: { url: "http://directory.internal" } } }, "test-tenants": {} });
    expect(seen).toEqual(["acme:active", "globex:active", "initech:suspended"]);
    const answers = await Promise.all(Array.from({ length: 10 }, () => app.fetch("/whoami", as("acme"))));
    expect(answers.map((response) => response.status)).toEqual(Array(10).fill(200));
    expect(calls).toBe(1);
    expect((await app.fetch("/whoami", as("nope"))).status).toBe(404);
  });

  test("any other answer is a failure: 503 with Retry-After 5 when nothing is cached", async () => {
    mock = http.mock();
    mock.service("directory" as never).on("GET", "/tenants/acme").reply(500, { error: "down" });
    const app = await start({ source: "service", service: "directory" }, { http: { services: { directory: { url: "http://directory.internal" } } } });
    const response = await app.fetch("/whoami", as("acme"));
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await errorOf(response)).toEqual({ status: 503, code: "TENANT_DIRECTORY_UNAVAILABLE", message: "Tenant directory is unavailable" });
  });
});

describe("the cache", () => {
  const logs: { message?: unknown }[] = [];
  const logger = { info: (entry: object) => void logs.push(entry), warn: (entry: object) => void logs.push(entry), error: (entry: object) => void logs.push(entry) };
  const options = { ttl: 300_000, negativeTtl: 30_000, staleTtl: 3_600_000, maxEntries: 2 };

  test("tenants live for ttl, unknown ids for negativeTtl, and the least recently used go beyond maxEntries", async () => {
    let now = 0;
    directoryClock.now = () => now;
    const lookups: string[] = [];
    const source = configDirectory({ a: {}, b: {}, c: {} });
    const counting: TenantDirectory = { find: (id) => (lookups.push(id), source.find(id)), list: () => source.list() };
    const cache = cachedDirectory(() => counting, options, logger);
    await cache.find("a");
    await cache.find("zz");
    await cache.find("a");
    await cache.find("zz");
    expect(lookups).toEqual(["a", "zz"]);
    now = 31_000;
    await cache.find("zz");
    await cache.find("a");
    expect(lookups).toEqual(["a", "zz", "zz"]);
    await cache.find("b");
    await cache.find("c");
    await cache.find("a");
    expect(lookups.at(-1)).toBe("a");
  });

  test("a failing lookup uses an entry younger than staleTtl, logging once per minute, then answers unavailable", async () => {
    let now = 0;
    directoryClock.now = () => now;
    let failing = false;
    const source: TenantDirectory = {
      find: async (id): Promise<TenantInfo | undefined> => {
        if (failing) throw new Error("directory down");
        return { id, status: "active", attributes: {} };
      },
      list: async function* () {},
    };
    logs.length = 0;
    const cache = cachedDirectory(() => source, options, logger);
    expect((await cache.find("acme"))?.id).toBe("acme");
    failing = true;
    now = 301_000;
    expect((await cache.find("acme"))?.id).toBe("acme");
    now = 302_000;
    expect((await cache.find("acme"))?.id).toBe("acme");
    expect(logs.filter((entry) => entry.message === "tenancy.directory.stale")).toHaveLength(1);
    now = 3_700_000;
    await expect(cache.find("acme")).rejects.toThrow("Tenant directory is unavailable");
  });

  test("through the app: a stale tenant is served, then the directory answers 503", async () => {
    let now = 0;
    directoryClock.now = () => now;
    mock = http.mock();
    let down = false;
    mock.service("directory" as never).on("GET", "/tenants/acme").replyWith(() => (down ? { status: 502, body: {} } : { status: 200, body: { id: "acme" } }));
    const app = await start({ source: "service", service: "directory" }, { http: { services: { directory: { url: "http://directory.internal" } } } });
    expect((await app.fetch("/whoami", as("acme"))).status).toBe(200);
    down = true;
    now = 400_000;
    expect((await app.fetch("/whoami", as("acme"))).status).toBe(200);
    expect(app.logs.some((entry) => entry.message === "tenancy.directory.stale")).toBe(true);
    now = 4_000_000;
    const response = await app.fetch("/whoami", as("acme"));
    expect([response.status, response.headers.get("retry-after")]).toEqual([503, "5"]);
  });
});
