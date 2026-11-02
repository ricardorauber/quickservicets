import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import type { SecretProvider } from "./features/secrets/index.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import type { Endpoint } from "./http/server.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import { secret } from "./options.ts";
import { refreshSecrets, secrets, setSecretsClock } from "./secret-references.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

let now = Date.parse("2026-11-02T10:00:00.000Z");
const advance = (ms: number) => void (now += ms);
setSecretsClock(() => now);

const running: TestApp[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  registerProjectFeatures([]);
});

/** A provider for `test://` backed by a map from path to value, counting and optionally slowing its calls. */
function vault(values: Record<string, string>, delayMs = 0) {
  const calls: string[] = [];
  const failing = new Set<string>();
  const provider: SecretProvider = {
    schemes: ["test"],
    async resolve(reference) {
      calls.push(reference.text);
      if (delayMs > 0) await Bun.sleep(delayMs);
      if (failing.has(reference.path)) throw new Error("vault refused the request");
      const value = values[reference.path];
      if (value === undefined) throw new Error(`${reference.text}: not found`);
      return { value };
    },
  };
  return { provider, calls, fail: (path: string) => void failing.add(path), values };
}

const providerFeature = (provider: SecretProvider) => defineFeature({ key: "vault-test", enabledByDefault: true, requires: ["secrets"], setup: (ctx) => ctx.feature("secrets").provider(provider) });

const models = markTenancy([entity("Note", [field({ name: "text", type: "string" })])]);
const as = (tenant: string) => ({ headers: { "x-tenant-id": tenant } });

/** A memory root whose tenant stores are recorded as they open. */
function recordingMemory() {
  const root = memoryAdapter();
  const opened: string[] = [];
  const forConnection = root.forConnection!.bind(root);
  root.forConnection = (connection) => {
    opened.push(String(connection));
    return forConnection(connection);
  };
  return { root, opened };
}

async function start(provider: SecretProvider, config: Record<string, unknown>, extra: { database?: ReturnType<typeof memoryAdapter>; endpoints?: { path: string; handler: Endpoint }[] } = {}) {
  registerProjectFeatures([{ folder: "vault-test", definition: providerFeature(provider) }]);
  const app = await startTestApp({ models, ...(extra.database ? { database: extra.database } : {}), ...(extra.endpoints ? { endpoints: extra.endpoints } : {}), config: { secrets: {}, ...config } });
  running.push(app);
  return app;
}

const tenancy = { source: "config", tenants: { acme: {}, globex: {}, initech: {} } };

describe("placeholder parsing, id checks and the startup refusal", () => {
  test("a {tenant} reference outside tenant connections fails startup", async () => {
    registerProjectFeatures([{ folder: "vault-test", definition: providerFeature(vault({}).provider) }]);
    const config = resolveConfig({ database: memoryAdapter(), secrets: {}, env: { KEY: secret() } } as ServiceConfig, { KEY: "test://t/{tenant}#k" });
    const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
    await expect(lifecycle.setup()).rejects.toThrow("env.KEY uses {tenant}, which only works for tenant connections, tenant entries and secrets.forTenant()");
    await lifecycle.stop();
  });

  test("a tenant id that would change the path never reaches the provider", async () => {
    const { provider, calls } = vault({ "tenants/acme/stripe": "sk_acme_123" });
    const app = await start(provider, { tenancy }, { endpoints: [{ path: "/key", handler: async (_repos, req) => ({ key: (await req.secrets.get(secret("test://tenants/{tenant}/stripe"))).length }) }] });
    expect((await app.fetch("/key", as("../admin"))).status).toBe(400);
    await expect(secrets.forTenant("../x").get("test://tenants/{tenant}/stripe")).rejects.toThrow('Invalid tenant id "../x"');
    expect(calls).toEqual([]);
  });
});

describe("tenant connections and directory entries with references", () => {
  test("tenancy.connection with {tenant} opens each tenant with its own connection, resolved once on first request", async () => {
    const { provider, calls } = vault({ "tenants/acme": JSON.stringify({ dsn: "acme-store" }), "tenants/globex": JSON.stringify({ dsn: "globex-store" }) });
    const { root, opened } = recordingMemory();
    const app = await start(provider, { tenancy: { ...tenancy, strategy: "database", connection: secret("test://tenants/{tenant}#dsn") } }, { database: root });
    expect(calls).toEqual([]);
    for (let i = 0; i < 2; i++) {
      expect((await app.fetch("/notes", as("acme"))).status).toBe(200);
      expect((await app.fetch("/notes", as("globex"))).status).toBe(200);
    }
    expect(opened).toEqual(["acme-store", "globex-store"]);
    expect(calls).toEqual(["test://tenants/acme#dsn", "test://tenants/globex#dsn"]);
  });

  test("a configured tenant's own connection may be a reference", async () => {
    const { provider } = vault({ "initech/db": "initech-store" });
    const { root, opened } = recordingMemory();
    const app = await start(provider, { tenancy: { source: "config", strategy: "database", tenants: { initech: { connection: secret("test://{tenant}/db") } } } }, { database: root });
    expect((await app.fetch("/notes", as("initech"))).status).toBe(200);
    expect(opened).toEqual(["initech-store"]);
  });
});

describe("forTenant, req.secrets and single flight", () => {
  test("req.secrets.get returns each tenant's key, and ten concurrent requests call the provider once", async () => {
    const { provider, calls } = vault({ "tenants/acme/stripe": JSON.stringify({ key: "sk_acme_key_1" }), "tenants/globex/stripe": JSON.stringify({ key: "sk_globex_key_1" }) }, 20);
    const app = await start(provider, { tenancy }, { endpoints: [{ path: "/stripe", handler: async (_repos, req) => ({ key: await req.secrets.get(secret("test://tenants/{tenant}/stripe#key")) }) }] });
    const answers = await Promise.all(Array.from({ length: 10 }, () => app.fetch("/stripe", as("acme")).then((response) => response.json())));
    expect(answers).toEqual(Array.from({ length: 10 }, () => ({ key: "sk_acme_key_1" })));
    expect(await (await app.fetch("/stripe", as("globex"))).json()).toEqual({ key: "sk_globex_key_1" });
    expect(calls).toEqual(["test://tenants/acme/stripe#key", "test://tenants/globex/stripe#key"]);
    expect(await secrets.forTenant("acme").get("test://tenants/{tenant}/stripe#key")).toBe("sk_acme_key_1");
    expect(calls.length).toBe(2);
  });
});

describe("cache size, eviction and idle refresh", () => {
  test("a third tenant evicts the least recently used, and an idle tenant is not refreshed after its ttl", async () => {
    const { provider, calls } = vault({ "t/acme": "acme-value-1", "t/globex": "globex-value-1", "t/initech": "initech-value-1" });
    await start(provider, { secrets: { tenantCacheSize: 2, ttl: "1m" }, tenancy });
    const get = (tenant: string) => secrets.forTenant(tenant).get("test://t/{tenant}");
    await get("acme");
    await get("globex");
    await get("acme");
    await get("initech");
    expect(calls).toEqual(["test://t/acme", "test://t/globex", "test://t/initech"]);
    // globex was the least recently used, so it is resolved again.
    await get("globex");
    expect(calls.at(-1)).toBe("test://t/globex");
    const before = calls.length;
    // acme was evicted by globex; initech and globex stay. Only globex is read after resolving.
    await get("globex");
    advance(60_000);
    await refreshSecrets();
    expect(calls.slice(before)).toEqual(["test://t/globex"]);
  });
});

describe("per-tenant failures and masking", () => {
  test("a failing tenant answers 503 while another works, logs secrets.tenant.failed and is not retried within 10 seconds", async () => {
    const { provider, calls, fail } = vault({ "tenants/acme": "acme-store", "tenants/globex": "globex-store" });
    fail("tenants/globex");
    const { root } = recordingMemory();
    const app = await start(provider, { secrets: { retries: 0 }, tenancy: { ...tenancy, strategy: "database", connection: secret("test://tenants/{tenant}") } }, { database: root });
    expect((await app.fetch("/notes", as("globex"))).status).toBe(503);
    expect((await app.fetch("/notes", as("acme"))).status).toBe(200);
    expect(app.logs.find((entry) => entry.message === "secrets.tenant.failed")).toMatchObject({ tenant: "globex", reference: "test://tenants/{tenant}" });
    const globexCalls = () => calls.filter((call) => call.includes("globex")).length;
    expect(globexCalls()).toBe(1);
    await expect(secrets.forTenant("globex").get("test://tenants/{tenant}")).rejects.toThrow("vault refused the request");
    expect(globexCalls()).toBe(1);
    advance(10_000);
    await expect(secrets.forTenant("globex").get("test://tenants/{tenant}")).rejects.toThrow("vault refused the request");
    expect(globexCalls()).toBe(2);
  });

  test("a log entry containing a tenant's resolved key shows [secret]", async () => {
    const { provider } = vault({ "tenants/acme/stripe": "sk_acme_masked_key" });
    let logger: { info(entry: Record<string, unknown>): void } | undefined;
    const audit = defineFeature({ key: "audit-log", enabledByDefault: true, setup: (ctx) => void (logger = ctx.logger as never) });
    registerProjectFeatures([
      { folder: "vault-test", definition: providerFeature(provider) },
      { folder: "audit-log", definition: audit },
    ]);
    const app = await startTestApp({
      models,
      config: { secrets: {}, tenancy },
      endpoints: [
        {
          path: "/log",
          handler: async (_repos, req) => {
            const key = await req.secrets.get("test://tenants/{tenant}/stripe");
            logger!.info({ timestamp: new Date().toISOString(), message: "stripe.key", detail: `using ${key}` });
            return { ok: true };
          },
        },
      ],
    });
    running.push(app);
    expect((await app.fetch("/log", as("acme"))).status).toBe(200);
    expect(app.logs.find((item) => item.message === "stripe.key")?.detail).toBe("using [secret]");
  });
});
