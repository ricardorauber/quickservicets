import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { ConfigError, resolveConfig, type ServiceConfig } from "./config.ts";
import { overrideVariables } from "./environment.ts";
import { secretVariableValues } from "./env-vars.ts";
import type { ErrorReport } from "./error-reports.ts";
import { activeFeatureDefinitions } from "./features.ts";
import { databaseAdapters, databaseRouter, errorDatabase, isDatabaseRouter, type DatabaseRouter } from "./named-databases.ts";
import type { Repository } from "./repository.ts";
import { currentDatabaseScope } from "./database-scope.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

const quiet = { info() {}, warn() {}, error() {} };
const resolve = (config: Record<string, unknown>, env: Record<string, string> = {}) => resolveConfig({ logger: quiet, ...config } as ServiceConfig, env);

const order = entity("Order", [field({ name: "number", type: "string", unique: true })], { schema: "orders", schemaKey: "orders", name: "orders", repoKey: "orders", tableName: "orders", key: "orders/Order", database: "orders" });
const product = entity("Product", [field({ name: "name", type: "string" })], { database: "catalog" });
const customer = entity("Customer", [field({ name: "name", type: "string" })], { database: "default" });
const models = [customer, order, product];

const running: TestApp[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
});

describe("the databases config key", () => {
  test("named adapters and { adapter, tenancy } resolve, and the default database stays database", () => {
    const orders = sqliteAdapter({ path: ":memory:" });
    const catalog = memoryAdapter();
    const main = memoryAdapter();
    const config = resolve({ database: main, databases: { orders, catalog: { adapter: catalog, tenancy: "shared" } } });
    expect(Object.keys(config.databases)).toEqual(["orders", "catalog"]);
    expect(config.databases.catalog).toEqual({ name: "catalog", adapter: catalog, tenancy: "shared" });
    expect(isDatabaseRouter(config.database)).toBe(true);
    expect(Object.keys((config.database as DatabaseRouter).databases)).toEqual(["default", "catalog", "orders"]);
    expect((config.database as DatabaseRouter).databases.default).toBe(main);
    expect(config.database.kind).toBe("memory");
  });

  test("without databases the default adapter is used directly", () => {
    const main = memoryAdapter();
    const config = resolve({ database: main });
    expect(config.database).toBe(main);
    expect(config.databases).toEqual({});
    expect(databaseAdapters(main)).toEqual([["default", main]]);
  });

  test("names that are not lowercase or are default fail naming the entry", () => {
    expect(() => resolve({ databases: { Orders: memoryAdapter() } })).toThrow(new ConfigError("Invalid databases.Orders: names must match ^[a-z][a-z0-9-]*$"));
    expect(() => resolve({ databases: { default: memoryAdapter() } })).toThrow("Invalid databases.default: the name default is taken by the database of database");
    expect(() => resolve({ databases: { orders: { tenancy: "shared" } } })).toThrow("Invalid databases.orders: expected a database adapter or { adapter, tenancy? }");
    expect(() => resolve({ databases: { orders: { adapter: memoryAdapter(), tenancy: "each" } } })).toThrow('Invalid databases.orders: tenancy must be "per-tenant" or "shared", got "each"');
  });
});

describe("QS_DATABASES_<NAME>_URL", () => {
  test("replaces the named adapter through forConnection and is a known, secret variable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "named-databases-"));
    const other = join(dir, "other.db");
    const configured = sqliteAdapter({ path: join(dir, "orders.db") });
    const config = resolve({ databases: { orders: configured, "order-archive": sqliteAdapter({ path: ":memory:" }) } }, { QS_DATABASES_ORDERS_URL: other });
    expect(config.databases.orders!.adapter).not.toBe(configured);
    await config.database.connect([order]);
    await config.database.disconnect();
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(dir, "orders.db"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    expect(config.warnings).toEqual([]);
    expect(secretVariableValues()).toContain(other);
    const variables = overrideVariables(activeFeatureDefinitions(), { databases: { orders: {}, "order-archive": {} } });
    expect(variables.get("QS_DATABASES_ORDERS_URL")).toEqual({ path: "databases.orders.url", secret: true });
    expect(variables.get("QS_DATABASES_ORDER_ARCHIVE_URL")).toEqual({ path: "databases.order-archive.url", secret: true });
  });

  test("refuses the memory adapter, which has no connection", () => {
    expect(() => resolve({ databases: { catalog: memoryAdapter() } }, { QS_DATABASES_CATALOG_URL: "x" })).toThrow(new ConfigError("QS_DATABASES_CATALOG_URL cannot be used with the memory adapter"));
  });

  test("an unusable connection fails without its value", () => {
    expect(() => resolve({ databases: { orders: postgresAdapter({ url: "postgres://localhost/a" }) } }, { QS_DATABASES_ORDERS_URL: "mysql://app:hunter2@db/x" })).toThrow(/^Invalid QS_DATABASES_ORDERS_URL \(databases.orders\): (?!.*hunter2)/);
  });
});

describe("routing", () => {
  test("each entity's repository reads and writes its own database, and the root scope holds every adapter", async () => {
    const main = memoryAdapter();
    const orders = memoryAdapter();
    const catalog = memoryAdapter();
    const app = await startTestApp({ database: main, models, config: { databases: { orders, catalog } } });
    running.push(app);
    const post = (path: string, body: unknown) => app.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = (await (await post("/orders/orders", { number: "A-1" })).json()) as { id: string };
    expect((await post("/products", { name: "Pen" })).status).toBe(201);
    expect((await post("/customers", { name: "Ada" })).status).toBe(201);
    expect(await orders.findById(order, created.id)).not.toBeNull();
    expect(await main.count(order, [])).toBe(0);
    expect(await catalog.count(product, [])).toBe(1);
    expect(await main.count(customer, [])).toBe(1);
    const repos = app.app.repos as unknown as { orders: { orders: Repository } };
    expect((await repos.orders.orders.findById(created.id))?.number).toBe("A-1");
    expect(currentDatabaseScope().databases).toEqual({ default: main, catalog, orders });
  });

  test("a transaction belongs to the database of the first entity it touches and rolls back there", async () => {
    const main = memoryAdapter();
    const orders = memoryAdapter();
    const router = databaseRouter(main, { orders });
    await router.connect(models);
    await expect(
      router.transaction(async () => {
        await router.insert(order, { id: "o1", number: "A-1", createdAt: new Date(), updatedAt: new Date() });
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await orders.findById(order, "o1")).toBeNull();
    await router.transaction(async () => {
      await router.insert(order, { id: "o2", number: "A-2", createdAt: new Date(), updatedAt: new Date() });
    });
    expect(await orders.findById(order, "o2")).not.toBeNull();
  });
});

/** An adapter whose connect and disconnect are recorded. */
function recorded(adapter: DatabaseAdapter, events: string[], name: string): DatabaseAdapter {
  const connect = adapter.connect.bind(adapter);
  const disconnect = adapter.disconnect.bind(adapter);
  adapter.connect = async (own, options) => {
    events.push(`connect ${name} ${own.map((model) => model.key).join(",")}`);
    return connect(own, options);
  };
  adapter.disconnect = async () => {
    events.push(`disconnect ${name}`);
    return disconnect();
  };
  return adapter;
}

describe("connecting", () => {
  test("connects default first then by name with each database's models, and disconnects every database", async () => {
    const events: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const router = databaseRouter(recorded(memoryAdapter(), events, "default"), { orders: recorded(memoryAdapter(), events, "orders"), catalog: recorded(memoryAdapter(), events, "catalog"), archive: recorded(memoryAdapter(), events, "archive") }, { logger: { info: (entry) => void logs.push(entry), warn() {}, error() {} } });
    await router.connect(models);
    expect(events).toEqual(["connect default Customer", "connect archive ", "connect catalog Product", "connect orders orders/Order"]);
    expect(logs.map((entry) => entry.message)).toEqual(["database archive holds no entity"]);
    await router.connect(models);
    expect(logs).toHaveLength(1);
    events.length = 0;
    await router.disconnect();
    expect(events.sort()).toEqual(["disconnect archive", "disconnect catalog", "disconnect default", "disconnect orders"]);
  });

  test("an unreachable database fails naming it without its password, after closing the ones already connected", async () => {
    const events: string[] = [];
    const orders = postgresAdapter({ url: "postgres://app:hunter2@127.0.0.1:1/orders", connectionTimeout: 2 } as never);
    const router = databaseRouter(recorded(memoryAdapter(), events, "default"), { orders });
    const failure = await router.connect(models).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toStartWith("Cannot connect database orders (postgres): ");
    expect(failure?.message).not.toContain("hunter2");
    expect(errorDatabase(failure)).toBe("orders");
    expect(failure?.cause).toBeDefined();
    expect(events).toEqual(["connect default Customer", "disconnect default"]);
  });
});

describe("database names in errors", () => {
  test("an adapter error of a named database is logged and reported with database", async () => {
    const reports: ErrorReport[] = [];
    const orders = memoryAdapter();
    let router: DatabaseAdapter | undefined;
    const app = await startTestApp({
      models: [customer, order],
      config: { databases: { orders }, errors: { reporter: { report: (report: ErrorReport) => void reports.push(report) } } },
      endpoints: [
        {
          method: "POST",
          path: "/raw-orders",
          // Writes through the adapter, without the repository's 409 for duplicates.
          handler: async () => router!.insert(order, { id: crypto.randomUUID(), number: "dup", createdAt: new Date(), updatedAt: new Date() }),
        },
      ],
    });
    running.push(app);
    router = app.config.database;
    expect((await app.fetch("/raw-orders", { method: "POST" })).status).toBe(200);
    expect((await app.fetch("/raw-orders", { method: "POST" })).status).toBe(500);
    const logged = app.logs.find((entry) => entry.level === "error" && (entry as { error?: { name?: string } }).error?.name === "UniqueViolationError");
    expect(logged?.database).toBe("orders");
    await Bun.sleep(10);
    expect(reports.map((report) => report.database)).toEqual(["orders"]);
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
const mongodbUrl = process.env.TEST_MONGODB_URL;

describe.skipIf(!postgresUrl || !mongodbUrl)("on PostgreSQL and MongoDB", () => {
  test("a default SQLite database, a PostgreSQL orders and a MongoDB catalog each hold their entities", async () => {
    const pgOrder = { ...order, schema: null, schemaKey: undefined, key: "Order" };
    const placed = [customer, pgOrder, product];
    const orders = postgresAdapter({ url: postgresUrl! });
    const catalog = mongodbAdapter({ url: mongodbUrl!, database: `qs_b10c_${Bun.randomUUIDv7().replaceAll("-", "")}` });
    const main = sqliteAdapter({ path: ":memory:" });
    const router = databaseRouter(main, { orders, catalog });
    await router.connect(placed);
    try {
      await resetPostgresTables(orders.client!, [pgOrder]);
      await createSqliteTables(main.client!, [customer]);
      const at = new Date();
      await router.insert(pgOrder, { id: "o1", number: "A-1", createdAt: at, updatedAt: at });
      await router.insert(product, { id: "p1", name: "Pen", createdAt: at, updatedAt: at });
      await router.insert(customer, { id: "c1", name: "Ada", createdAt: at, updatedAt: at });
      expect((await orders.findById(pgOrder, "o1"))?.number).toBe("A-1");
      expect((await catalog.findById(product, "p1"))?.name).toBe("Pen");
      expect((await main.findById(customer, "c1"))?.name).toBe("Ada");
      await expect(router.transaction(async () => {
        await router.updateById(pgOrder, "o1", { number: "A-2" });
        throw new Error("stop");
      })).rejects.toThrow("stop");
      expect((await orders.findById(pgOrder, "o1"))?.number).toBe("A-1");
    } finally {
      await catalog.db?.dropDatabase();
      await router.disconnect();
    }
  });
});
