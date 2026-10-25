import { describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import type { Endpoint } from "./http/server.ts";
import type { LogEntry } from "./logger.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import { afterCommit, configureTransactions, inTransaction, onRollback, publicTransaction, transaction } from "./transactions.ts";

const order = entity("Order", [field({ name: "item", type: "string" })]);
const stock = entity("Stock", [field({ name: "count", type: "number" })]);
const user = entity("User", [field({ name: "name", type: "string" })]);
const team = entity("Team", [field({ name: "name", type: "string" }), field({ name: "members", type: "refArray", target: "User", onDelete: "pull", optional: true })]);
const models = [order, stock, user, team];

type Factory = () => DatabaseAdapter;
const factories: [string, Factory][] = [
  ["memory", () => memoryAdapter()],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
];
if (process.env.TEST_POSTGRES_URL) factories.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `qs_tx_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

const entries: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };

type Repos = Record<string, Repository> & { transaction<T>(fn: () => Promise<T>): Promise<T> };

async function setup(factory: Factory) {
  const adapter = factory();
  await adapter.connect(models);
  const client = (adapter as unknown as { client: never }).client;
  if (adapter.kind === "sqlite") await createSqliteTables(client, models);
  if (adapter.kind === "postgres") await resetPostgresTables(client, models);
  configureTransactions(adapter, logger);
  return { adapter, repos: createRepositories(models, adapter) as unknown as Repos };
}

const countOf = async (repository: Repository) => (await repository.query().all()).length;

const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe.each(factories)("%s", (_, factory) => {
  test("an endpoint whose transaction throws leaves no write behind and responds 500", async () => {
    const { adapter, repos } = await setup(factory);
    const { id } = await repos.stocks!.create({ count: 5 });
    const handler: Endpoint = async (endpointRepos) =>
      (endpointRepos as unknown as Repos).transaction(async () => {
        await (endpointRepos as unknown as Repos).orders!.create({ item: "book" });
        await (endpointRepos as unknown as Repos).stocks!.update(id, { count: 4 });
        throw new Error("x");
      });
    const config = resolveConfig({ database: adapter, logger } as ServiceConfig, {});
    const app = createApp({ models, crudRoutes: [], endpoints: [{ method: "POST", path: "/orders", hooks: [], handler }], hooks: new Map(), config });
    const response = await app.server.fetch(new Request("http://localhost/orders", { method: "POST" }));
    expect(response.status).toBe(500);
    expect(await repos.orders!.query().all()).toEqual([]);
    expect((await repos.stocks!.findById(id))!.count).toBe(5);
    await adapter.disconnect();
  });

  test("transaction and repos.transaction commit together and resolve with the result", async () => {
    const { adapter, repos } = await setup(factory);
    const result = await repos.transaction(async () => {
      await repos.orders!.create({ item: "a" });
      await transaction(async () => repos.stocks!.create({ count: 1 }));
      return "done";
    });
    expect(result).toBe("done");
    expect(await countOf(repos.orders!)).toBe(1);
    expect(await countOf(repos.stocks!)).toBe(1);
    await adapter.disconnect();
  });

  test("an internal transaction joins a public one: a reference array change rolls back with it", async () => {
    const { adapter, repos } = await setup(factory);
    const [a, b] = [await repos.users!.create({ name: "a" }), await repos.users!.create({ name: "b" })];
    const crew = await repos.teams!.create({ name: "t", members: [a.id] });
    expect(
      (
        await failure(() =>
          repos.transaction(async () => {
            await repos.teams!.update(crew.id, { members: { add: [b.id] } });
            throw new Error("undo");
          }),
        )
      ).message,
    ).toBe("undo");
    expect((await repos.teams!.findById(crew.id))!.members).toEqual([a.id]);
    await repos.transaction(async () => {
      await repos.teams!.update(crew.id, { members: { add: [b.id] } });
    });
    expect((await repos.teams!.findById(crew.id))!.members).toEqual([a.id, b.id]);
    await adapter.disconnect();
  });
});

describe("nesting", () => {
  test("an outer failure rolls back the inner writes, skips inner afterCommit and runs every onRollback", async () => {
    const { repos } = await setup(factories[0]![1]);
    const calls: string[] = [];
    await failure(() =>
      transaction(async () => {
        onRollback(() => void calls.push("outer rollback"));
        await transaction(async () => {
          await repos.orders!.create({ item: "inner" });
          afterCommit(() => void calls.push("inner commit"));
          onRollback(() => void calls.push("inner rollback"));
        });
        throw new Error("outer");
      }),
    );
    expect(await countOf(repos.orders!)).toBe(0);
    expect(calls).toEqual(["outer rollback", "inner rollback"]);
  });

  test("inner afterCommit callbacks run after the outer commit", async () => {
    await setup(factories[0]![1]);
    const calls: string[] = [];
    await transaction(async () => {
      await transaction(async () => {
        afterCommit(() => void calls.push("inner"));
      });
      calls.push("outer body");
    });
    expect(calls).toEqual(["outer body", "inner"]);
  });
});

describe("afterCommit, onRollback and inTransaction", () => {
  test("callbacks run in order after the commit; a failing one is logged and the next still runs", async () => {
    await setup(factories[0]![1]);
    entries.length = 0;
    const calls: string[] = [];
    await transaction(async () => {
      afterCommit(() => {
        throw new Error("a failed");
      });
      afterCommit(() => void calls.push("b"));
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(["b"]);
    expect(entries).toContainEqual(expect.objectContaining({ message: "transaction.after-commit.failed", error: expect.objectContaining({ message: "a failed" }) }));
  });

  test("outside a transaction afterCommit runs at once, onRollback does nothing, inTransaction is false", async () => {
    let ran = false;
    const promise = afterCommit(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    await promise;
    onRollback(() => {
      throw new Error("never");
    });
    expect(inTransaction()).toBe(false);
  });

  test("inTransaction is true inside a repository's internal transaction", async () => {
    const inner = memoryAdapter();
    const seen: boolean[] = [];
    const adapter: DatabaseAdapter = { ...inner, transaction: (fn) => inner.transaction(fn), updateById: async (...args) => (seen.push(inTransaction()), inner.updateById(...args)) };
    await adapter.connect(models);
    const repos = createRepositories(models, adapter) as unknown as Repos;
    const u = await repos.users!.create({ name: "a" });
    const crew = await repos.teams!.create({ name: "t" });
    await repos.teams!.update(crew.id, { members: { add: [u.id] } });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  test("a failing onRollback callback is logged", async () => {
    await setup(factories[0]![1]);
    entries.length = 0;
    await failure(() =>
      transaction(async () => {
        onRollback(() => {
          throw new Error("cleanup failed");
        });
        throw new Error("x");
      }),
    );
    expect(entries).toContainEqual(expect.objectContaining({ message: "transaction.on-rollback.failed" }));
  });
});

describe("the memory adapter", () => {
  test("rolls back inserts, updates and deletes, and serializes transactions", async () => {
    const { adapter, repos } = await setup(factories[0]![1]);
    expect(adapter.supportsRollback).toBe(true);
    const kept = await repos.orders!.create({ item: "kept" });
    const gone = await repos.orders!.create({ item: "gone" });
    await failure(() =>
      transaction(async () => {
        await repos.orders!.create({ item: "new" });
        await repos.orders!.update(kept.id, { item: "changed" });
        await repos.orders!.delete(gone.id);
        throw new Error("x");
      }),
    );
    expect((await repos.orders!.query().all()).map((record) => record.item).sort()).toEqual(["gone", "kept"]);

    const order: string[] = [];
    let release!: () => void;
    const first = transaction(async () => {
      order.push("first start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first end");
    });
    await Bun.sleep(1);
    const outside = countOf(repos.orders!).then(() => order.push("outside read"));
    const second = transaction(async () => void order.push("second"));
    await Bun.sleep(1);
    release();
    await Promise.all([first, outside, second]);
    // Nothing outside the running transaction ran before it ended.
    expect(order.slice(0, 2)).toEqual(["first start", "first end"]);
    expect(order.slice(2).sort()).toEqual(["outside read", "second"]);
  });
});

describe("databases without rollback", () => {
  test("the first public transaction warns once", async () => {
    const inner = memoryAdapter();
    const adapter: DatabaseAdapter = { ...inner, supportsRollback: false };
    await adapter.connect(models);
    configureTransactions(adapter, logger);
    entries.length = 0;
    await transaction(async () => undefined);
    await publicTransaction(adapter, async () => undefined);
    expect(entries.filter((entry) => entry.message === "transactions are not atomic on this database; writes in a failed transaction are kept")).toHaveLength(1);
  });

  test("built-in adapters report their rollback support", async () => {
    expect(memoryAdapter().supportsRollback).toBe(true);
    expect(sqliteAdapter({ path: ":memory:" }).supportsRollback).toBe(true);
    expect(postgresAdapter({ url: "postgres://localhost/none" }).supportsRollback).toBe(true);
    if (!process.env.TEST_MONGODB_URL) return;
    const mongo = mongodbAdapter({ url: process.env.TEST_MONGODB_URL, database: "qs_tx_flag" });
    expect(mongo.supportsRollback).toBe(false);
    await mongo.connect([]);
    // The test server is a replica set.
    expect(mongo.supportsRollback).toBe(true);
    await mongo.disconnect();
  });
});
