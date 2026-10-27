import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import type { TenantDirectory, TenantInfo } from "./features/tenancy/directory.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import type { Endpoint } from "./http/server.ts";
import { errorOf, startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import { createSqliteTables } from "./testing/sql.ts";

const models = markTenancy([entity("Post", [field({ name: "title", type: "string" })])]);
const whoami: Endpoint = (_repos, req) => ({ tenant: (req.tenant as { id?: string } | undefined)?.id ?? null });

const running: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function start(tenancy: Record<string, unknown>, env: Record<string, string> = {}, extra: Partial<Parameters<typeof startTestApp>[0]> = {}) {
  const app = await startTestApp({ database: memoryAdapter(), models, endpoints: [{ path: "/whoami", handler: whoami }], config: { tenancy }, env, ...extra });
  running.push(app);
  return app;
}
const tenantOf = async (response: Response) => ((await response.json()) as { tenant: string | null }).tenant;

describe("environment variables", () => {
  test("QS_TENANCY_HEADER, QS_TENANCY_FROM with QS_TENANCY_DOMAIN, and a config tenant's status", async () => {
    const tenants = { source: "config", tenants: { acme: {}, globex: {} } };
    const header = await start(tenants, { QS_TENANCY_HEADER: "x-org" });
    expect(await tenantOf(await header.fetch("/whoami", { headers: { "x-org": "acme" } }))).toBe("acme");
    await header.stop();
    const ordered = await start(tenants, { QS_TENANCY_FROM: "subdomain,header", QS_TENANCY_DOMAIN: "app.test" });
    expect(await tenantOf(await ordered.fetch("/whoami", { host: "globex.app.test", headers: { host: "globex.app.test", "x-tenant-id": "globex" } }))).toBe("globex");
    expect(await tenantOf(await ordered.fetch("/whoami", { headers: { host: "app.test", "x-tenant-id": "acme" } }))).toBe("acme");
    await ordered.stop();
    const suspended = await start(tenants, { QS_TENANCY_TENANTS_ACME_STATUS: "suspended" });
    expect((await suspended.fetch("/whoami", { headers: { "x-tenant-id": "acme" } })).status).toBe(403);
  });
});

describe("the strategy function", () => {
  test("enterprise tenants get their own SQLite file, free ones a schema of the root; one call per tenant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-strategy-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const enterprise = sqliteAdapter({ path: join(dir, "tenant_globex.db") });
    await enterprise.connect(models);
    await createSqliteTables(enterprise.client!, models);
    await enterprise.disconnect();
    const root = sqliteAdapter({ path: join(dir, "root.db") });
    const connect = root.connect.bind(root);
    root.connect = async (list) => {
      await connect(list);
      await createSqliteTables(root.client!, models, { defaultSchema: "tenant-acme" });
    };
    const calls: string[] = [];
    const strategy = ({ tenant }: { tenant: TenantInfo }) => (calls.push(tenant.id), tenant.plan === "enterprise" ? "database" : "schema");
    const app = await start(
      { source: "config", strategy, connection: join(dir, "tenant_{tenant}.db"), tenants: { acme: { plan: "free" }, globex: { plan: "enterprise" } } },
      {},
      { database: root },
    );
    for (let index = 0; index < 50; index++) {
      for (const tenant of ["acme", "globex"]) expect((await app.fetch("/posts", { headers: { "x-tenant-id": tenant } })).status).toBe(200);
    }
    const create = (tenant: string) => app.fetch("/posts", { method: "POST", headers: { "x-tenant-id": tenant, "content-type": "application/json" }, body: JSON.stringify({ title: tenant }) });
    expect((await create("acme")).status).toBe(201);
    expect((await create("globex")).status).toBe(201);
    expect(root.client!.query("select title from tenant_acme__posts").all()).toEqual([{ title: "acme" }]);
    const { Database } = await import("bun:sqlite");
    const file = new Database(join(dir, "tenant_globex.db"));
    expect(file.query("select title from posts").all()).toEqual([{ title: "globex" }]);
    file.close();
    expect(calls.sort()).toEqual(["acme", "globex"]);
  });
});

describe("hooks", () => {
  test("beforeResolve maps www to no tenant, onUnknownTenant sees unknown ids, and a throwing afterResolve is logged", async () => {
    const unknown: string[] = [];
    const app = await start({
      source: "config",
      from: ["subdomain"],
      domain: "app.test",
      tenants: { acme: {} },
      beforeResolve: ({ id }: { id?: string }) => (id === "www" ? null : undefined),
      onUnknownTenant: ({ id }: { id: string }) => void unknown.push(id),
      afterResolve: () => {
        throw new Error("audit is down");
      },
    });
    expect(await errorOf(await app.fetch("/whoami", { headers: { host: "www.app.test" } }))).toEqual({ status: 400, code: "TENANT_REQUIRED", message: "Tenant is required" });
    expect((await app.fetch("/whoami", { headers: { host: "nope.app.test" } })).status).toBe(404);
    expect(unknown).toEqual(["nope"]);
    expect(await tenantOf(await app.fetch("/whoami", { headers: { host: "acme.app.test" } }))).toBe("acme");
    expect(app.logs.some((entry) => entry.message === "feature.hook.failed" && JSON.stringify(entry).includes("audit is down"))).toBe(true);
  });

  test("onPoolOpen and onPoolClose run with the tenant and the reason", async () => {
    const seen: string[] = [];
    const app = await start({
      source: "config",
      strategy: "database",
      tenants: { acme: { connection: `hooks-${Bun.randomUUIDv7()}` } },
      onPoolOpen: ({ tenant }: { tenant: string }) => void seen.push(`open ${tenant}`),
      onPoolClose: ({ tenant, reason }: { tenant: string; reason?: string }) => void seen.push(`close ${tenant} ${reason}`),
    });
    await app.fetch("/whoami", { headers: { "x-tenant-id": "acme" } });
    await app.stop();
    expect(seen).toEqual(["open acme", "close acme shutdown"]);
  });
});

describe("providers", () => {
  test("a directory provider and a resolver replace the source and the sources", async () => {
    const map = new Map<string, TenantInfo>([["acme", { id: "acme", plan: "pro", status: "active", attributes: {} }]]);
    const directory: TenantDirectory = { find: async (id) => map.get(id), list: async function* () { yield* map.values(); } };
    const resolver = { resolve: ({ req }: { req: Request & { headers: Headers } }) => req.headers.get("x-org-slug") ?? undefined };
    const app = await start({ directory, resolver });
    expect(await tenantOf(await app.fetch("/whoami", { headers: { "x-org-slug": "acme" } }))).toBe("acme");
    expect((await app.fetch("/whoami", { headers: { "x-tenant-id": "acme" } })).status).toBe(400);
    expect((await app.fetch("/whoami", { headers: { "x-org-slug": "nope" } })).status).toBe(404);
    expect((await app.fetch("/whoami", { headers: { "x-org-slug": "Not Valid" } })).status).toBe(400);
  });

  test("a feature may set the directory once; with the config's directory too, startup fails naming both", async () => {
    const map = new Map<string, TenantInfo>([["initech", { id: "initech", status: "active", attributes: {} }]]);
    const directory: TenantDirectory = { find: async (id) => map.get(id), list: async function* () { yield* map.values(); } };
    registerNative(defineFeature({ key: "test-directory", docs: { summary: "Test." }, after: ["tenancy"], setup: (ctx) => ctx.feature("tenancy").setDirectory(directory) }));
    cleanups.push(() => unregisterNative("test-directory"));
    const app = await start({}, {}, { config: { tenancy: {}, "test-directory": {} } });
    expect(await tenantOf(await app.fetch("/whoami", { headers: { "x-tenant-id": "initech" } }))).toBe("initech");
    await app.stop();
    const failure = await startTestApp({ database: memoryAdapter(), models, config: { tenancy: { directory }, "test-directory": {} } }).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toBe("test-directory failed in setup: The tenant directory is set by the config (tenancy.directory) and test-directory; keep one");
  });
});
