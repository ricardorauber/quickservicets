import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { databaseTenancyProblems, markTenancy } from "./features/tenancy/models.ts";
import type { EntityModel } from "./model.ts";
import { type DatabaseRouter } from "./named-databases.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import { postgresDdl } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";

const order = entity("Order", [field({ name: "number", type: "string" })], { key: "orders/Order", schema: "orders", schemaKey: "orders", database: "orders" });
const product = entity("Product", [field({ name: "name", type: "string" })], { key: "catalog/Product", schema: "catalog", schemaKey: "catalog", database: "catalog" });
const note = entity("Note", [field({ name: "text", type: "string" })], { database: "default" });
const placed = { orders: "per-tenant", catalog: "shared" } as const;
const models = markTenancy([order, product, note], placed);
const quiet = { info() {}, warn() {}, error() {} };

const running: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const as = (tenant: string) => ({ headers: { "x-tenant-id": tenant } });
const post = (tenant: string, body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenant }, body: JSON.stringify(body) });
const names = async (response: Response) => ((await response.json()) as { data: Record<string, string>[] }).data.map((row) => row.number ?? row.name);

describe("defaults", () => {
  test("with the tenancy native a named database is per tenant unless it says shared; without it every database is global", () => {
    const tenancy = { tenancy: { source: "config", tenants: { acme: {} } } };
    const config = resolveConfig({ logger: quiet, databases: { orders: memoryAdapter(), catalog: { adapter: memoryAdapter(), tenancy: "shared" } }, ...tenancy } as ServiceConfig, {});
    expect(config.databases.orders!.tenancy).toBe("per-tenant");
    expect(config.databases.catalog!.tenancy).toBe("shared");
    const plain = resolveConfig({ logger: quiet, databases: { orders: memoryAdapter(), catalog: { adapter: memoryAdapter(), tenancy: "shared" } } } as ServiceConfig, {});
    expect(plain.databases.orders!.tenancy).toBeUndefined();
    expect(plain.warnings).toContain("databases.catalog.tenancy has no effect without the tenancy native");
  });

  test("entities of a per-tenant database hold tenant data even in a module folder, those of a shared one are shared", () => {
    expect(models.map((model) => [model.key, model.tenancy])).toEqual([
      ["orders/Order", "tenant"],
      ["catalog/Product", "shared"],
      ["Note", "tenant"],
    ]);
  });

  test("a @tenancy tag against its database's tenancy is a problem naming the file", () => {
    const shared = { ...order, tags: { tenancy: { on: true, options: { scope: "shared" } } } } as EntityModel;
    const tenant = { ...product, tags: { tenancy: { on: true, options: { scope: "tenant" } } } } as EntityModel;
    expect(databaseTenancyProblems([shared, tenant], placed)).toEqual([
      "entities/orders/Order.ts: Order lives in database orders, which is per tenant; move it to a shared database or remove @tenancy shared",
      "entities/catalog/Product.ts: Product lives in database catalog, which is shared; move it to a per-tenant database or remove @tenancy tenant",
    ]);
  });
});

async function start(databases: Record<string, unknown>, tenancy: Record<string, unknown> = {}, database: DatabaseAdapter = memoryAdapter()) {
  const app = await startTestApp({ database, models, config: { databases, tenancy: { source: "config", tenants: { acme: {}, globex: {} }, ...tenancy } } });
  running.push(app);
  return app;
}

describe("the schema strategy", () => {
  test("each tenant has its own orders, in its schema of the orders database, and every tenant shares the catalog", async () => {
    const app = await start({ orders: memoryAdapter(), catalog: { adapter: memoryAdapter(), tenancy: "shared" } });
    expect((await app.fetch("/orders/orders", post("acme", { number: "A-1" }))).status).toBe(201);
    expect((await app.fetch("/catalog/products", post("acme", { name: "Pen" }))).status).toBe(201);
    expect(await names(await app.fetch("/orders/orders", as("acme")))).toEqual(["A-1"]);
    expect(await names(await app.fetch("/orders/orders", as("globex")))).toEqual([]);
    expect(await names(await app.fetch("/catalog/products", as("globex")))).toEqual(["Pen"]);
    const router = app.config.database as DatabaseRouter;
    expect((router.withSchema!("tenant-acme") as DatabaseRouter).databases.catalog).toBe(router.databases.catalog);
  });

  test("a per-tenant database without withSchema fails startup naming it", async () => {
    const orders = memoryAdapter();
    delete (orders as { withSchema?: unknown }).withSchema;
    await expect(start({ orders, catalog: { adapter: memoryAdapter(), tenancy: "shared" } })).rejects.toThrow('tenancy strategy "schema" needs an adapter with withSchema(); the memory adapter of database orders has none');
  });

  const url = process.env.TEST_POSTGRES_URL;
  test.skipIf(!url)("PostgreSQL: acme reads its orders from schema tenant-acme of the orders database and products from the shared catalog", async () => {
    const orders = postgresAdapter({ url: url! });
    const connect = orders.connect.bind(orders);
    const schemas = ["qs_b10c_t_acme", "qs_b10c_t_globex"];
    orders.connect = async (list) => {
      await connect(list);
      for (const schema of schemas) {
        // quickservicets-allow-unsafe: test DDL for schemas this test names
        await orders.client!.unsafe(`drop schema if exists "${schema}" cascade; create schema "${schema}";`);
        // quickservicets-allow-unsafe: runs the DDL drizzle-kit generates from the models
        for (const statement of await postgresDdl([{ ...order, schema: null, schemaKey: undefined }], { defaultSchema: schema })) await orders.client!.unsafe(statement);
      }
    };
    cleanups.push(async () => {
      // quickservicets-allow-unsafe: test DDL for schemas this test names
      for (const schema of schemas) await orders.client?.unsafe(`drop schema if exists "${schema}" cascade`);
      await orders.disconnect();
    });
    const app = await start({ orders, catalog: { adapter: memoryAdapter(), tenancy: "shared" } }, { schema: "qs-b10c-t-{tenant}" });
    expect((await app.fetch("/orders/orders", post("acme", { number: "A-1" }))).status).toBe(201);
    expect((await app.fetch("/catalog/products", post("globex", { name: "Pen" }))).status).toBe(201);
    expect((await orders.client!.unsafe('select number from "qs_b10c_t_acme".orders')) as unknown).toEqual([{ number: "A-1" }]);
    expect((await orders.client!.unsafe('select count(*)::int as n from "qs_b10c_t_globex".orders')) as unknown).toEqual([{ n: 0 }]);
    expect(await names(await app.fetch("/catalog/products", as("acme")))).toEqual(["Pen"]);
  });
});

describe("the database strategy", () => {
  test("tenantConnection opens the tenant's own copy of the named database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-tenant-orders-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const orders = sqliteAdapter({ path: ":memory:" });
    const forConnection = orders.forConnection.bind(orders);
    orders.forConnection = (connection) => {
      const copy = forConnection(connection);
      const connect = copy.connect.bind(copy);
      copy.connect = async (list) => {
        await connect(list);
        await createSqliteTables(copy.client!, [{ ...order, schema: null, schemaKey: undefined }]);
      };
      return copy;
    };
    const main = memoryAdapter();
    const app = await start({ orders: { adapter: orders, tenantConnection: join(dir, "orders_{tenant}.db") }, catalog: { adapter: memoryAdapter(), tenancy: "shared" } }, { strategy: "database", connection: "main_{tenant}" }, main);
    expect((await app.fetch("/orders/orders", post("acme", { number: "A-1" }))).status).toBe(201);
    expect(existsSync(join(dir, "orders_acme.db"))).toBe(true);
    expect(await names(await app.fetch("/orders/orders", as("acme")))).toEqual(["A-1"]);
    expect(await names(await app.fetch("/orders/orders", as("globex")))).toEqual([]);
  });

  test("without tenantConnection startup fails", async () => {
    await expect(start({ orders: memoryAdapter(), catalog: { adapter: memoryAdapter(), tenancy: "shared" } }, { strategy: "database", connection: "main_{tenant}" })).rejects.toThrow(
      "databases.orders.tenantConnection is required for database-strategy tenants",
    );
  });
});
