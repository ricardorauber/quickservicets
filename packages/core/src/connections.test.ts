import { describe, expect, test } from "bun:test";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import { failedBeforeSend, withReconnect, type ConnectionPoolSettings, type DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import type { LogEntry } from "./logger.ts";
import "./index.ts";

/** A memory adapter recording the pool settings it receives. */
const spyAdapter = () => {
  const calls: ConnectionPoolSettings[] = [];
  const adapter = Object.assign(memoryAdapter(), { configurePool: (settings: ConnectionPoolSettings) => void calls.push(settings) }) as DatabaseAdapter;
  return { adapter, calls };
};

const recorder = () => {
  const entries: LogEntry[] = [];
  const keep = (entry: LogEntry) => void entries.push(entry);
  return { entries, logger: { info: keep, warn: keep, error: keep } };
};

/** Resolves a config and runs the features' setups, as a service does before connecting. */
async function setUp(config: Record<string, unknown>, env: Record<string, string> = {}) {
  const resolved = resolveConfig(config as ServiceConfig, env);
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: false } });
  await lifecycle.setup();
  await lifecycle.stop();
  return resolved;
}

const settingsOnly = (calls: ConnectionPoolSettings[]) => calls.map(({ onReconnect: _, ...settings }) => settings);

describe("mode resolution and defaults", () => {
  test("on lambda a project gets two lazy connections and the serverless limits; on a server nothing is configured", async () => {
    const lambda = spyAdapter();
    await setUp({ database: lambda.adapter, logger: recorder().logger, deploy: { target: "lambda" } });
    expect(settingsOnly(lambda.calls)).toEqual([{ max: 2, idleTimeout: "30s", maxLifetime: "15m", connectTimeout: "5s", lazy: true }]);
    const azure = spyAdapter();
    await setUp({ database: azure.adapter, logger: recorder().logger }, { QS_DEPLOY_TARGET: "azure-functions" });
    expect(settingsOnly(azure.calls)[0]).toMatchObject({ max: 2, lazy: true });
    const server = spyAdapter();
    await setUp({ database: server.adapter, logger: recorder().logger });
    expect(server.calls).toEqual([]);
    const forced = spyAdapter();
    await setUp({ database: forced.adapter, logger: recorder().logger, connections: { mode: "serverless", max: 3 } });
    expect(settingsOnly(forced.calls)).toEqual([{ max: 3, idleTimeout: "30s", maxLifetime: "15m", connectTimeout: "5s", lazy: true }]);
  });

  test("on a server, set options are applied over the adapter's own", async () => {
    const server = spyAdapter();
    await setUp({ database: server.adapter, logger: recorder().logger, connections: { max: 5, idleTimeout: "10s" } });
    expect(settingsOnly(server.calls)).toEqual([{ max: 5, idleTimeout: "10s" }]);
  });
});

describe("pool options per adapter", () => {
  test("the MongoDB adapter turns them into driver options", () => {
    const adapter = mongodbAdapter({ url: "mongodb://localhost:27017", database: "app" });
    adapter.configurePool!({ max: 5, idleTimeout: "10s", connectTimeout: "5s" });
    expect(adapter.clientOptions).toEqual({ maxPoolSize: 5, maxIdleTimeMS: 10_000, connectTimeoutMS: 5000 });
  });

  test.skipIf(!process.env.TEST_POSTGRES_URL)("the PostgreSQL adapter passes them to Bun.SQL", async () => {
    const adapter = postgresAdapter({ url: process.env.TEST_POSTGRES_URL! });
    adapter.configurePool!({ max: 5, idleTimeout: "10s" });
    await adapter.connect([], {});
    try {
      const options = (adapter.client as unknown as { options: { max: number; idleTimeout: number } }).options;
      expect(options.max).toBe(5);
      expect(options.idleTimeout).toBe(10_000);
    } finally {
      await adapter.disconnect();
    }
  });

  test("memory and SQLite adapters take no pool settings", () => {
    expect(memoryAdapter().configurePool).toBeUndefined();
  });
});

describe("lazy connection", () => {
  test.skipIf(!process.env.TEST_MONGODB_URL)("a lazy MongoDB adapter opens no connection until its first operation", async () => {
    const adapter = mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: "qs_b13_lazy" });
    adapter.configurePool!({ lazy: true });
    await adapter.connect([], {});
    try {
      const topology = () => (adapter.client as unknown as { topology?: unknown }).topology;
      expect(topology()).toBeUndefined();
      await adapter.db!.collection("probe").findOne({});
      expect(topology()).toBeDefined();
    } finally {
      await adapter.disconnect();
    }
  });

  test.skipIf(!process.env.TEST_POSTGRES_URL)("the PostgreSQL pool opens its first connection on the first query", async () => {
    const admin = new Bun.SQL({ url: process.env.TEST_POSTGRES_URL!, max: 1 });
    const sessions = async () => Number((await admin.unsafe("select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()"))[0].n);
    const adapter = postgresAdapter({ url: process.env.TEST_POSTGRES_URL! });
    adapter.configurePool!({ lazy: true, max: 2 });
    try {
      const before = await sessions();
      await adapter.connect([], {});
      expect(await sessions()).toBe(before);
      await adapter.client!.unsafe("select 1");
      expect(await sessions()).toBeGreaterThan(before);
    } finally {
      await adapter.disconnect();
      await admin.close();
    }
  });
});

describe("reconnect rules", () => {
  test("a connection closed before the statement is retried once with a report; one failing after it was sent is not", async () => {
    const reports: unknown[] = [];
    let attempts = 0;
    const closed = Object.assign(new Error("socket closed"), { code: "ECONNRESET", sent: false });
    const result = await withReconnect(
      async () => {
        attempts++;
        throw closed;
      },
      async () => (attempts++, "answered"),
      "insert into posts values ($1)",
      (error) => reports.push(error),
    );
    expect(result).toBe("answered");
    expect(attempts).toBe(2);
    expect(reports).toEqual([closed]);
    const sent = Object.assign(new Error("Connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED", sent: true });
    await expect(withReconnect(async () => Promise.reject(sent), async () => "never", "select 1")).rejects.toBe(sent);
    expect(failedBeforeSend({ code: "ERR_POSTGRES_CONNECTION_CLOSED" }, "select * from posts")).toBe(true);
    expect(failedBeforeSend({ code: "ERR_POSTGRES_CONNECTION_CLOSED" }, "insert into posts values (1)")).toBe(false);
    expect(failedBeforeSend({ code: "23505" }, "select 1")).toBe(false);
  });

  test("the native logs connections.reconnected through the adapter's report", async () => {
    const { adapter, calls } = spyAdapter();
    const { entries, logger } = recorder();
    await setUp({ database: adapter, logger, connections: { mode: "serverless" } });
    calls[0]!.onReconnect!(Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
    expect(entries.find((entry) => entry.message === "connections.reconnected")).toMatchObject({ database: "default", error: { code: "ECONNRESET" } });
  });
});

describe("the budget", () => {
  test("max 5 with two workers and 20 instances warns against a budget of 100", async () => {
    const { adapter } = spyAdapter();
    const { entries, logger } = recorder();
    await setUp({ database: postgresAdapter({ url: "postgres://localhost/app" }), logger, server: { workers: 2 }, connections: { max: 5, instances: 20, budget: 100 } });
    expect(entries.map((entry) => entry.message)).toContain("connections may reach 200, above connections.budget 100; lower connections.max or use a connection proxy");
    void adapter;
  });
});

describe("per-database pool settings", () => {
  test("the default database gets the native's settings and a named one its own, each pool reported", async () => {
    const main = spyAdapter();
    const orders = spyAdapter();
    const { entries, logger } = recorder();
    await setUp({ database: main.adapter, databases: { orders: orders.adapter }, logger, connections: { max: 5, databases: { orders: { max: 2 } } } });
    expect(settingsOnly(main.calls)).toEqual([{ max: 5 }]);
    expect(settingsOnly(orders.calls)).toEqual([{ max: 2 }]);
    expect(entries.find((entry) => entry.message === "connections.pools")).toMatchObject({ mode: "server", pools: { default: { max: 5 }, orders: { max: 2 } } });
  });
});
