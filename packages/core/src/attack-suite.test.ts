import { afterEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { runAttackSuite, SQL_PAYLOADS, startAttackHarness, urlAttack, type AttackHarness, type AttackSuiteOptions } from "./testing/attack-suite.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";

runAttackSuite({ name: "memory", adapter: () => memoryAdapter() });

runAttackSuite({ name: "memory, security off", adapter: () => memoryAdapter(), config: { security: false } });

describe("attack suite harness", () => {
  const long = SQL_PAYLOADS.find((payload) => payload.label === "a 10 KB string")!.value;
  const longFilter = `/items?${new URLSearchParams({ "where[title][eq]": long }).toString()}`;
  let harness: AttackHarness | undefined;
  const start = async (config?: AttackSuiteOptions["config"]) =>
    (harness = await startAttackHarness({ name: "memory", adapter: () => memoryAdapter(), ...(config ? { config } : {}) }));
  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  /** Stores the long payload and a short title, returning the long record's id. */
  const seed = async (running: AttackHarness) => {
    const created = await running.fetch("POST", "/items", JSON.stringify({ title: long }));
    expect(created.status).toBe(201);
    await running.fetch("POST", "/items", JSON.stringify({ title: "Alpha" }));
    return ((await created.json()) as { id: string }).id;
  };

  test("responses carry the security headers with the natives on", async () => {
    const running = await start();
    const response = await running.fetch("GET", "/items");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("a URL over the limit is expected as 414 with an unchanged snapshot", async () => {
    const running = await start();
    await seed(running);
    expect(running.urlTooLong(longFilter)).toBe(true);
    const before = await running.snapshot();
    let filtered = false;
    await urlAttack(running, "GET", longFilter, () => void (filtered = true));
    expect(filtered).toBe(false);
    const response = await running.fetch("GET", longFilter);
    expect(response.status).toBe(414);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe("URL is too long");
    expect(await running.snapshot()).toEqual(before);
  });

  test("with security off the long URL gets the filter result", async () => {
    const running = await start({ security: false });
    const id = await seed(running);
    expect(running.urlTooLong(longFilter)).toBe(false);
    let ids: string[] = [];
    await urlAttack(running, "GET", longFilter, async (response) => {
      expect(response.status).toBe(200);
      ids = ((await response.json()) as { data: { id: string }[] }).data.map((record) => record.id);
    });
    expect(ids).toEqual([id]);
    expect((await running.fetch("GET", "/items")).headers.get("x-content-type-options")).toBeNull();
  });

  test("a raised limits.url lets the long URL through", async () => {
    const running = await start({ security: { limits: { url: "64KB" } } });
    const id = await seed(running);
    expect(running.urlTooLong(longFilter)).toBe(false);
    let ids: string[] = [];
    await urlAttack(running, "GET", longFilter, async (response) => {
      expect(response.status).toBe(200);
      ids = ((await response.json()) as { data: { id: string }[] }).data.map((record) => record.id);
    });
    expect(ids).toEqual([id]);
  });
});

runAttackSuite({
  name: "sqlite",
  adapter: () => {
    const adapter = sqliteAdapter({ path: ":memory:" });
    const connect = adapter.connect.bind(adapter);
    adapter.connect = async (models) => {
      await connect(models);
      await createSqliteTables(adapter.client!, models);
    };
    return adapter;
  },
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  runAttackSuite({
    name: "postgres",
    adapter: () => {
      const adapter = postgresAdapter({ url: postgresUrl });
      const connect = adapter.connect.bind(adapter);
      adapter.connect = async (models) => {
        await connect(models);
        await resetPostgresTables(adapter.client!, models);
      };
      return adapter;
    },
  });
} else {
  test.skip("attack suite: postgres (set TEST_POSTGRES_URL to run)", () => {});
}

const mongodbUrl = process.env.TEST_MONGODB_URL;
if (mongodbUrl) {
  runAttackSuite({
    name: "mongodb",
    adapter: () => {
      const adapter = mongodbAdapter({ url: mongodbUrl, database: `qs_attack_${Bun.randomUUIDv7().replaceAll("-", "")}` });
      const connect = adapter.connect.bind(adapter);
      const disconnect = adapter.disconnect.bind(adapter);
      adapter.connect = async (models) => {
        await connect(models);
        for (const model of models) await adapter.createIndexes(model);
      };
      adapter.disconnect = async () => {
        await adapter.db?.dropDatabase();
        await disconnect();
      };
      return adapter;
    },
  });
} else {
  test.skip("attack suite: mongodb (set TEST_MONGODB_URL to run)", () => {});
}
