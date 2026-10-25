import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import type { QueueBroker } from "./features/queues/broker.ts";
import { databaseBroker } from "./features/queues/database.ts";
import { queueMessageEntity } from "./features/queues/message.ts";
import { QUEUE_BROKER_CHECKS, runQueueBrokerContract } from "./testing/queue-broker-contract.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import { runInTransaction } from "./transactions.ts";
import "./index.ts";

const model = queueMessageEntity();

/** Runs the contract against the database broker over one adapter, connected once with its table. */
function databaseContract(name: string, open: () => Promise<DatabaseAdapter>) {
  let adapter: Promise<DatabaseAdapter> | undefined;
  const connected = () => (adapter ??= open());
  // The factory is asynchronous, so every optional method's test runs: the database broker has them all.
  runQueueBrokerContract(async () => databaseBroker({ adapter: await connected(), model }), {
    name: `database (${name})`,
    transaction: async (fn) => runInTransaction(await connected(), fn),
  });
}

databaseContract("memory", async () => {
  const adapter = memoryAdapter();
  await adapter.connect([model]);
  return adapter;
});
databaseContract("sqlite", async () => {
  const adapter = sqliteAdapter({ path: join(mkdtempSync(join(tmpdir(), "qs-broker-")), "db.sqlite") });
  await adapter.connect([model]);
  await createSqliteTables(adapter.client!, [model]);
  return adapter;
});
if (process.env.TEST_POSTGRES_URL) {
  databaseContract("postgres", async () => {
    const adapter = postgresAdapter({ url: process.env.TEST_POSTGRES_URL! });
    await adapter.connect([model]);
    await resetPostgresTables(adapter.client!, [model]);
    return adapter;
  });
}

/** A broker that keeps messages in memory and loses the dedupe, retry and priority rules: the contract must notice. */
function brokenBroker(): QueueBroker {
  const waiting: { id: string; queue: string; payload: unknown }[] = [];
  let ctx: Parameters<QueueBroker["start"]>[0] | undefined;
  const drain = () => {
    while (ctx && waiting.length > 0) {
      const message = waiting.shift()!;
      void ctx.handle({ id: message.id, queue: message.queue, payload: message.payload, attempt: 1, enqueuedAt: new Date() }, { signal: new AbortController().signal });
    }
  };
  return {
    name: "broken",
    async enqueue(message) {
      const id = Bun.randomUUIDv7();
      waiting.push({ id, queue: message.queue, payload: message.payload });
      drain();
      return { id, deduplicated: false };
    },
    start(context) {
      ctx = context;
      drain();
    },
    async stop() {
      ctx = undefined;
    },
    async stats() {
      return {};
    },
  };
}

describe("the contract itself", () => {
  test("a broken broker fails every check but plain processing", async () => {
    const failing: string[] = [];
    for (const check of QUEUE_BROKER_CHECKS.filter((entry) => !entry.needs)) {
      try {
        await check.run(brokenBroker, { ioWait: 1 });
      } catch {
        failing.push(check.name);
      }
    }
    expect(failing).toEqual([
      "runs at most concurrency messages of a queue at once",
      "retries a failed message with exponential backoff",
      "runs a delayed message once its time has come",
      "runs higher priorities first",
      "deduplicates messages of a queue by key while they are live",
      "publishes nothing for an enqueue in a rolled-back transaction, and the message after a commit",
      "stop waits for running messages and takes no new ones",
      "stats counts the waiting messages of a queue",
    ]);
  }, 120_000);

  test("checks of optional methods are skipped for a broker without them", () => {
    expect(QUEUE_BROKER_CHECKS.filter((check) => check.needs).map((check) => check.needs)).toEqual(["dead", "retry", "retryDead", "cleanup", "health"]);
    expect(typeof (brokenBroker() as QueueBroker).dead).toBe("undefined");
  });
});

describe("the broker option", () => {
  test("queues.broker must have the required methods", () => {
    expect(() => resolveConfig({ database: memoryAdapter(), queues: { broker: { enqueue() {} } } } as unknown as ServiceConfig, {})).toThrow(/Invalid queues\.broker: .*start/);
    const broker = brokenBroker();
    const config = resolveConfig({ database: memoryAdapter(), queues: { broker } } as unknown as ServiceConfig, {});
    expect(config.features.find((feature) => feature.key === "queues")!.options.broker).toBe(broker);
  });
});
