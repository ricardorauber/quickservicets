import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./index.ts";
import type { DatabaseAdapter, StoredRecord } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { databaseStagedModel, relayAllDatabases, stagedSystemTarget } from "./database-staging.ts";
import { HttpError } from "./errors.ts";
import { queueMessageEntity } from "./features/queues/message.ts";
import { currentOperation, disableOperationContext, enableOperationContext, withOperation } from "./operation-context.ts";
import { CrossDatabaseTransactionError, databaseRouter, type DatabaseRouter } from "./named-databases.ts";
import { afterCommit, configureTransactions, transaction } from "./transactions.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

const customer = entity("Customer", [field({ name: "name", type: "string" })], { database: "default" });
const order = entity("Order", [field({ name: "number", type: "string" }), field({ name: "customer", type: "ref", target: "Customer", onDelete: "restrict", optional: true })], { database: "orders" });
const messages = { ...queueMessageEntity(), database: "default" };
const quiet = { info() {}, warn() {}, error() {} };

const record = (fields: Record<string, unknown>): StoredRecord => ({ id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...fields });
const CROSS = "Cannot use Customer (database default) inside a transaction of database orders; a transaction covers one database. Use a saga or the outbox for changes across databases";

let main: DatabaseAdapter;
let orders: DatabaseAdapter;
let router: DatabaseRouter;
beforeEach(async () => {
  main = memoryAdapter();
  orders = memoryAdapter();
  router = databaseRouter(main, { orders });
  await router.connect([customer, order, messages]);
  configureTransactions(router, quiet);
});

describe("which database a transaction belongs to", () => {
  test("the first entity touched binds it, and a read of another database is refused and rolls back", async () => {
    const failure = await transaction(async () => {
      await router.insert(order, record({ id: "o1", number: "A-1" }));
      await router.findMany(customer, { where: [], sort: [], limit: 1, offset: 0 });
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CrossDatabaseTransactionError);
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({ status: 500, code: "CROSS_DATABASE_TRANSACTION", message: CROSS });
    expect(await orders.findById(order, "o1")).toBeNull();
  });

  test("writes are refused like reads", async () => {
    await expect(transaction(async () => {
      await router.findById(order, "x");
      await router.insert(customer, record({ name: "Ada" }));
    })).rejects.toThrow(CROSS);
    expect(await main.count(customer, [])).toBe(0);
  });

  test("{ database } fixes it from the start, and touching nothing is allowed", async () => {
    await expect(transaction(async () => void (await router.findById(customer, "c")), { database: "orders" })).rejects.toThrow(CROSS);
    expect(await transaction(async () => "nothing", { database: "orders" })).toBe("nothing");
    await expect(transaction(async () => "x", { database: "nope" })).rejects.toThrow("Unknown database nope (configured: default, orders)");
  });
});

describe("nesting and afterCommit", () => {
  test("a nested transaction joins on the same database and is refused on another", async () => {
    await transaction(async () => {
      await router.insert(order, record({ id: "o2", number: "A-2" }));
      await transaction(async () => router.insert(order, record({ id: "o3", number: "A-3" })), { database: "orders" });
      await expect(transaction(async () => "x", { database: "default" })).rejects.toThrow(
        "Cannot use a transaction (database default) inside a transaction of database orders; a transaction covers one database. Use a saga or the outbox for changes across databases",
      );
    });
    expect(await orders.count(order, [])).toBe(2);
    await transaction(async () => {
      await transaction(async () => router.insert(order, record({ id: "o4", number: "A-4" })), { database: "orders" });
    });
    expect(await orders.findById(order, "o4")).not.toBeNull();
  });

  test("afterCommit of an orders transaction runs after its commit, and not after a rollback", async () => {
    const seen: string[] = [];
    await transaction(async () => {
      await router.insert(order, record({ id: "o5", number: "A-5" }));
      void afterCommit(async () => void seen.push(`committed ${Boolean(await orders.findById(order, "o5"))}`));
      seen.push("inside");
    });
    await transaction(async () => {
      await router.insert(order, record({ number: "A-6" }));
      void afterCommit(() => void seen.push("never"));
      throw new Error("stop");
    }).catch(() => {});
    expect(seen).toEqual(["inside", "committed true"]);
  });
});

describe("staging core rows", () => {
  test("a queue message of a default table added in an orders transaction is staged in orders and relayed after the commit", async () => {
    const staged = databaseStagedModel(messages, "orders");
    await transaction(async () => {
      await router.insert(order, record({ number: "A-7" }));
      const target = stagedSystemTarget(router, messages)!;
      expect(target.model).toBe(staged);
      await target.adapter.insert(target.model, record({ queue: "notify", status: "waiting" }));
      // Read through the router, inside the orders transaction.
      expect(await router.count(staged, [])).toBe(1);
      expect(await main.count(messages, [])).toBe(0);
    });
    expect(await orders.count(staged, [])).toBe(0);
    expect(await main.count(messages, [])).toBe(1);
    await transaction(async () => {
      await router.insert(order, record({ number: "A-8" }));
      const target = stagedSystemTarget(router, messages)!;
      await target.adapter.insert(target.model, record({ queue: "notify", status: "waiting" }));
      throw new Error("stop");
    }).catch(() => {});
    expect(await orders.count(staged, [])).toBe(0);
    expect(await main.count(messages, [])).toBe(1);
    expect(stagedSystemTarget(router, messages)).toBeUndefined();
  });

  test("an interrupted relay is resumed without copying a row twice", async () => {
    const staged = databaseStagedModel(messages, "orders");
    const copied = record({ queue: "notify", status: "waiting" });
    const left = record({ queue: "notify", status: "waiting" });
    // A relay stopped after copying one row and before deleting it from the staging table, and one never relayed.
    await main.insert(messages, copied);
    await orders.insert(staged, copied);
    await orders.insert(staged, left);
    await relayAllDatabases(router, 0);
    expect((await main.findMany(messages, { where: [], sort: [{ field: "id", direction: "asc" }], limit: 10, offset: 0 })).data.map((row) => row.id).sort()).toEqual([copied.id, left.id].sort());
    expect(await orders.count(staged, [])).toBe(0);
  });
});

describe("the operation context", () => {
  afterEach(() => disableOperationContext());

  test("carries the database of the open transaction", async () => {
    enableOperationContext();
    await withOperation({ requestId: "r1" }, async () => {
      expect(currentOperation()).toEqual({ requestId: "r1" });
      await transaction(async () => {
        await router.findById(order, "x");
        expect(currentOperation()).toEqual({ requestId: "r1", database: "orders" });
      });
    });
  });
});

describe("generated routes", () => {
  const running: TestApp[] = [];
  afterEach(async () => {
    for (const app of running.splice(0)) await app.stop();
  });

  test("a create checks the customer on the default database before the orders transaction writes the order", async () => {
    const events: string[] = [];
    const ordersDb = memoryAdapter();
    const mainDb = memoryAdapter();
    const findById = mainDb.findById.bind(mainDb);
    mainDb.findById = (model, id, read) => (events.push(`default read ${model.entityName}`), findById(model, id, read));
    const begin = ordersDb.transaction.bind(ordersDb);
    ordersDb.transaction = (fn) => (events.push("orders begin"), begin(async () => {
      const result = await fn();
      events.push("orders commit");
      return result;
    }));
    const insert = ordersDb.insert.bind(ordersDb);
    ordersDb.insert = (model, row) => (events.push(`orders insert ${model.entityName}`), insert(model, row));
    const app = await startTestApp({ database: mainDb, models: [customer, order], config: { databases: { orders: ordersDb } } });
    running.push(app);
    const ada = await mainDb.insert(customer, record({ name: "Ada" }));
    const response = await app.fetch("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ number: "A-1", customer: ada.id }) });
    expect(response.status).toBe(201);
    expect(events).toEqual(["default read Customer", "orders begin", "orders insert Order", "orders commit"]);
  });
});

describe("checks across databases inside a transaction", () => {
  test("a write of another database is refused, not left waiting, when its check reads the transaction's own SQLite database", async () => {
    const { sqliteAdapter } = await import("./adapters/sqlite.ts");
    const { createSqliteTables } = await import("./testing/sql.ts");
    const { createRepositories } = await import("./repository.ts");
    const mainDb = sqliteAdapter({ path: ":memory:" });
    const ordersDb = memoryAdapter();
    const routed = databaseRouter(mainDb, { orders: ordersDb });
    await routed.connect([customer, order]);
    await createSqliteTables(mainDb.client!, [customer]);
    configureTransactions(routed, quiet);
    const repos = createRepositories([customer, order], routed) as unknown as Record<string, { create(body: unknown): Promise<{ id: string }> }>;
    const failure = await transaction(async () => {
      const ada = await repos.customers!.create({ name: "Ada" });
      await repos.orders!.create({ number: "A-1", customer: ada.id });
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "CROSS_DATABASE_TRANSACTION", message: "Cannot use Order (database orders) inside a transaction of database default; a transaction covers one database. Use a saga or the outbox for changes across databases" });
    expect(await mainDb.count(customer, [])).toBe(0);
    await routed.disconnect();
  }, 20_000);
});
