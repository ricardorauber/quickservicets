import { afterEach, describe, expect, spyOn, test } from "bun:test";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter, type SqliteAdapter } from "./adapters/sqlite.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { currentDatabaseScope } from "./database-scope.ts";
import { queue, queueMessageEntity } from "./features/queues/index.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import type { Endpoint } from "./http/server.ts";
import type { Repository } from "./repository.ts";
import { errorOf, startTestApp, type TestApp, type TestEndpointInput } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import { postgresDdl, resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import { transaction } from "./transactions.ts";

const models = markTenancy([
  entity("Post", [field({ name: "title", type: "string" })]),
  entity("Plan", [field({ name: "name", type: "string" })], { tags: { tenancy: { on: true, options: { scope: "shared" } } } }),
  entity("User", [field({ name: "email", type: "string" })], { schema: "qs-b08-auth", schemaKey: "qsB08Auth", key: "qs-b08-auth/User", repoKey: "users" }),
  queueMessageEntity(),
]);
const tenantModels = models.filter((model) => model.tenancy === "tenant");
const sharedModels = models.filter((model) => model.tenancy === "shared");
const TENANTS = { acme: {}, globex: {} };

const running: TestApp[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", "x-tenant-id": "acme" }, body: JSON.stringify(body) });
const as = (tenant: string) => ({ headers: { "x-tenant-id": tenant } });
const titles = async (response: Response) => ((await response.json()) as { data: { title: string }[] }).data.map((item) => item.title);

async function start(database: DatabaseAdapter, tenancy: Record<string, unknown> = {}, endpoints: TestEndpointInput[] = [], extra: Record<string, unknown> = {}, folders = {}) {
  const app = await startTestApp({ database, models, endpoints, config: { tenancy: { source: "config", tenants: TENANTS, ...tenancy }, ...extra }, featureFolders: folders });
  running.push(app);
  return app;
}

/** A SQLite file in memory with the shared tables and the tables of each tenant schema. */
function sqliteWithSchemas(...schemas: string[]): SqliteAdapter {
  const adapter = sqliteAdapter({ path: ":memory:" });
  const connect = adapter.connect.bind(adapter);
  adapter.connect = async (list) => {
    await connect(list);
    await createSqliteTables(adapter.client!, sharedModels);
    for (const schema of schemas) await createSqliteTables(adapter.client!, tenantModels, { defaultSchema: schema });
  };
  return adapter;
}

describe("requests run in their tenant's schema", () => {
  test("memory: a post of acme is not listed for globex", async () => {
    const app = await start(memoryAdapter());
    expect((await app.fetch("/posts", json({ title: "acme's" }))).status).toBe(201);
    expect(await titles(await app.fetch("/posts", as("globex")))).toEqual([]);
    expect(await titles(await app.fetch("/posts", as("acme")))).toEqual(["acme's"]);
  });

  test("SQLite: the post is stored in tenant_acme__posts", async () => {
    const database = sqliteWithSchemas("tenant-acme", "tenant-globex");
    const app = await start(database);
    expect((await app.fetch("/posts", json({ title: "acme's" }))).status).toBe(201);
    expect(database.client!.query("select title from tenant_acme__posts").all()).toEqual([{ title: "acme's" }]);
    expect(database.client!.query("select count(*) as n from tenant_globex__posts").get()).toEqual({ n: 0 });
    expect(await titles(await app.fetch("/posts", as("globex")))).toEqual([]);
  });

  const url = process.env.TEST_POSTGRES_URL;
  test.skipIf(!url)("PostgreSQL: the post is stored in the acme schema's posts table", async () => {
    const database = postgresAdapter({ url: url! });
    const connect = database.connect.bind(database);
    const schemas = ["qs_b08_t_acme", "qs_b08_t_globex"];
    database.connect = async (list) => {
      await connect(list);
      const client = database.client!;
      await client.unsafe(`drop schema if exists qs_b08_auth cascade; create schema qs_b08_auth;`);
      await resetPostgresTables(client, sharedModels);
      for (const schema of schemas) {
        // quickservicets-allow-unsafe: test DDL for schemas this test names
        await client.unsafe(`drop schema if exists ${schema} cascade; create schema ${schema};`);
        // quickservicets-allow-unsafe: test DDL for schemas this test names
        for (const statement of await postgresDdl(tenantModels, { defaultSchema: schema })) await client.unsafe(statement);
      }
    };
    cleanups.push(async () => {
      // quickservicets-allow-unsafe: test DDL for schemas this test names
      for (const schema of [...schemas, "qs_b08_auth"]) await database.client?.unsafe(`drop schema if exists ${schema} cascade`);
      await database.disconnect();
    });
    const app = await start(database, { schema: "qs-b08-t-{tenant}" });
    expect((await app.fetch("/posts", json({ title: "acme's" }))).status).toBe(201);
    expect((await database.client!.unsafe("select title from qs_b08_t_acme.posts")) as unknown).toEqual([{ title: "acme's" }]);
    expect(await titles(await app.fetch("/posts", as("globex")))).toEqual([]);
  });
});

describe("transactions, queues and the global functions", () => {
  test("the tenant's writes and the shared queue message commit or roll back together", async () => {
    const database = sqliteWithSchemas("tenant-acme");
    const handler: Endpoint = async (repos, req) =>
      transaction(async () => {
        await (repos as Record<string, Repository>).posts!.create({ title: "with mail" });
        await req.queue.add("mail" as never, { to: "a@x.test" } as never);
        expect(currentDatabaseScope().key).toBe("tenant:acme");
        if (req.query.get("fail")) throw new Error("rolled back");
        return { ok: true };
      });
    const app = await start(database, {}, [{ method: "POST", path: "/work", handler }], { queues: { pollInterval: "1h" } }, { queues: { queues: new Map([["mail", queue(async () => {})]]) } });
    expect((await app.fetch("/work?fail=1", { method: "POST", ...as("acme") })).status).toBe(500);
    expect(database.client!.query("select count(*) as n from tenant_acme__posts").get()).toEqual({ n: 0 });
    expect(database.client!.query("select count(*) as n from queue_messages").get()).toEqual({ n: 0 });
    expect((await app.fetch("/work", { method: "POST", ...as("acme") })).status).toBe(200);
    expect(database.client!.query("select count(*) as n from tenant_acme__posts").get()).toEqual({ n: 1 });
    expect(database.client!.query("select count(*) as n from queue_messages").get()).toEqual({ n: 1 });
  });
});

describe("schema names", () => {
  test("a tenant's own schema wins over the template; a template without {tenant} fails; an explicit schema's name is refused", async () => {
    const database = memoryAdapter();
    const views = spyOn(database, "withSchema");
    const app = await start(database, { tenants: { acme: { schema: "acme-eu" }, sneaky: { schema: "qs-b08-auth" } } });
    expect((await app.fetch("/posts", as("acme"))).status).toBe(200);
    expect(views.mock.calls.map(([name]) => name)).toEqual(["acme-eu"]);
    const conflict = await app.fetch("/posts", as("sneaky"));
    expect(conflict.status).toBe(500);
    expect(app.logs.find((entry) => entry.message === "tenancy.schema.conflict")).toMatchObject({ tenant: "sneaky", schema: "qs-b08-auth" });
    expect(() => resolveConfig({ database: memoryAdapter(), tenancy: { schema: "tenants" } } as ServiceConfig, {})).toThrow("tenancy.schema must contain {tenant}");
  });

  test("1000 requests of one tenant build its scope once", async () => {
    const database = memoryAdapter();
    const views = spyOn(database, "withSchema");
    const app = await start(database);
    for (let index = 0; index < 1000; index++) await app.fetch("/posts", as("acme"));
    expect(views).toHaveBeenCalledTimes(1);
  });
});

describe("adapters and tenants that are not ready", () => {
  test("an adapter without withSchema fails startup", async () => {
    const database = { ...memoryAdapter(), withSchema: undefined } as DatabaseAdapter;
    const failure = await startTestApp({ database, models, config: { tenancy: { source: "config" } } }).then(() => undefined, (error: Error) => error.message);
    expect(failure).toBe('tenancy failed in setup: tenancy strategy "schema" needs an adapter with withSchema(); the memory adapter has none');
  });

  test("a tenant whose schema was never migrated answers 503 and logs the hint", async () => {
    const database = sqliteWithSchemas("tenant-acme");
    const app = await start(database);
    const response = await app.fetch("/posts", as("globex"));
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await errorOf(response)).toEqual({ status: 503, code: "TENANT_UNAVAILABLE", message: "Tenant is not ready" });
    expect(app.logs.find((entry) => entry.message === "tenancy.tenant.not-provisioned")).toMatchObject({ tenant: "globex", hint: "run quickservicets migrate --tenant globex" });
  });

  test("an exempt endpoint lists shared records without a tenant", async () => {
    const app = await start(memoryAdapter(), {}, [
      { path: "/catalog", handler: (repos) => (repos as Record<string, Repository>).plans!.list({ where: [], sort: [], limit: 10, offset: 0 }), tags: { tenancy: { on: false, options: {} } } },
    ]);
    await (app.app.repos.plans as Repository).create({ name: "pro" });
    const response = await app.fetch("/catalog");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { total: number }).total).toBe(1);
  });
});

