import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { migrateTenant, provisionTenant } from "./features/tenancy/index.ts";
import { MONGO_MIGRATIONS_COLLECTION } from "./features/tenancy/migrate.ts";
import { tenantEntity } from "./features/tenancy/directory.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import type { Endpoint } from "./http/server.ts";
import { errorOf, startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

const models = markTenancy([entity("Post", [field({ name: "title", type: "string" })]), tenantEntity()]);

const running: TestApp[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("provisioning from code", () => {
  test("an endpoint provisions a tenant whose next request works; a second call fails; migrateTenant refuses unknown ids", async () => {
    const signup: Endpoint = async (_repos, req) => provisionTenant({ id: req.query.get("id")!, plan: "free" });
    const app = await startTestApp({ database: memoryAdapter(), models, config: { tenancy: {} }, endpoints: [{ method: "POST", path: "/signup", handler: signup, tags: { tenancy: { on: false, options: {} } } }] });
    running.push(app);
    expect((await app.fetch("/posts", { headers: { "x-tenant-id": "initech" } })).status).toBe(404);
    const created = await app.fetch("/signup?id=initech", { method: "POST" });
    expect(await created.json()).toEqual({ id: "initech", status: "active", applied: [] });
    expect((await app.fetch("/posts", { headers: { "x-tenant-id": "initech" } })).status).toBe(200);
    expect(await errorOf(await app.fetch("/signup?id=initech", { method: "POST" }))).toEqual({ status: 409, code: "TENANT_EXISTS", message: "Tenant initech already exists" });
    expect(await migrateTenant("initech")).toEqual({ id: "initech", status: "active", applied: [] });
    await expect(migrateTenant("nope")).rejects.toThrow("Unknown tenant nope");
  });
});

const url = process.env.TEST_MONGODB_URL;
describe.skipIf(!url)("MongoDB tenants", () => {
  test("a migrated tenant has its history collection, and a tenant without it is not ready", async () => {
    const database = mongodbAdapter({ url: url!, database: `qs_b08_root_${Date.now()}` });
    const app = await startTestApp({ database, models, config: { tenancy: { source: "config", schema: "qs-b08-{tenant}", tenants: { acme: {}, globex: {} } } } });
    running.push(app);
    cleanups.push(async () => {
      for (const name of ["qs_b08_acme", "qs_b08_globex"]) await database.client?.db(name).dropDatabase();
      await database.db?.dropDatabase();
    });
    expect(await migrateTenant("acme")).toEqual({ id: "acme", status: "active", applied: [] });
    expect((await database.client!.db("qs_b08_acme").listCollections({ name: MONGO_MIGRATIONS_COLLECTION }).toArray()).length).toBe(1);
    expect((await app.fetch("/posts", { headers: { "x-tenant-id": "acme" } })).status).toBe(200);
    const response = await app.fetch("/posts", { headers: { "x-tenant-id": "globex" } });
    expect(await errorOf(response)).toEqual({ status: 503, code: "TENANT_UNAVAILABLE", message: "Tenant is not ready" });
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)("PostgreSQL tenant schemas", () => {
  test("a tenant's statements create its tables in its schema, once, and shared statements stay out", async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { postgresAdapter } = await import("./adapters/postgres.ts");
    const { migrateTenantDatabase } = await import("./features/tenancy/migrate.ts");
    const root = mkdtempSync(join(tmpdir(), "qs-tenant-migrations-"));
    mkdirSync(join(root, "migrations"));
    writeFileSync(
      join(root, "migrations", "20261027120000_Initial.ts"),
      `export async function up(ctx) {
  await ctx.sql('CREATE TABLE "qs_b08_plans" ("id" text PRIMARY KEY NOT NULL)', { shared: true });
  await ctx.sql('CREATE TABLE "posts" ("id" text PRIMARY KEY NOT NULL, "title" text NOT NULL)');
}
export async function down() {}
`,
    );
    const database = postgresAdapter({ url: postgresUrl! });
    await database.connect(models);
    const client = database.client!;
    try {
      const target = { adapter: database.withSchema("qs-b08-acme"), schema: "qs-b08-acme", models: models.filter((model) => model.tenancy === "tenant") };
      expect(await migrateTenantDatabase(root, target)).toEqual({ applied: ["20261027120000_Initial"] });
      expect(await migrateTenantDatabase(root, target)).toEqual({ applied: [] });
      const found = (await client.unsafe("select table_schema, table_name from information_schema.tables where table_name in ('posts', 'qs_b08_plans') and table_schema like 'qs_b08%'")) as { table_schema: string; table_name: string }[];
      expect(found.map((row) => `${row.table_schema}.${row.table_name}`)).toEqual(["qs_b08_acme.posts"]);
    } finally {
      // quickservicets-allow-unsafe: drops the schema this test created
      await client.unsafe("drop schema if exists qs_b08_acme cascade");
      await database.disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
