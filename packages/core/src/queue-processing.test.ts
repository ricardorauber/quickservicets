import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAdapter } from "./adapters/memory.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { captureLogger, fakeClock, type FakeClock } from "./jobs/test-support.ts";
import { systemClock } from "./jobs/scheduler.ts";
import { createDatabaseQueue, RECLAIM_INTERVAL, type DatabaseQueueOptions } from "./features/queues/database.ts";
import { queueMessageEntity, type QueueMessage } from "./features/queues/message.ts";
import { queue, type QueueDefinition } from "./features/queues/queue.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import "./index.ts";

const model = queueMessageEntity();
const DEFAULTS = { concurrency: 1, timeout: "5m", retries: 3, retryDelay: "10s", maxRetryDelay: "1h" };

function setUp(adapter: DatabaseAdapter, definitions: Record<string, QueueDefinition>, extra: Partial<DatabaseQueueOptions> & { concurrency?: number; timeout?: string } = {}) {
  const { logger, entries } = captureLogger();
  const clock = (extra.clock ?? fakeClock()) as FakeClock;
  const store = createDatabaseQueue({
    adapter,
    model,
    definitions: new Map(Object.entries(definitions)),
    settings: () => ({ ...DEFAULTS, ...(extra.concurrency ? { concurrency: extra.concurrency } : {}), ...(extra.timeout ? { timeout: extra.timeout } : {}) }),
    pollInterval: "1s",
    logger,
    production: false,
    resultLimit: "64KB",
    worker: "test:1",
    ...extra,
    clock,
  });
  return { store, clock, entries };
}

async function memory() {
  const adapter = memoryAdapter();
  await adapter.connect([model]);
  return adapter;
}

const all = async (adapter: DatabaseAdapter) =>
  (await adapter.findMany(model, { where: [], sort: [{ field: "id", direction: "asc" }], limit: 10_000, offset: 0, withTotal: false })).data as unknown as QueueMessage[];

const until = async (check: () => Promise<boolean> | boolean, clock?: FakeClock) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return;
    if (clock) await clock.flush();
    else await Bun.sleep(5);
  }
  throw new Error("timed out waiting");
};

describe("claiming", () => {
  test("messages are processed, completed with the handler's result, and the claim is conditional", async () => {
    const adapter = await memory();
    const { store, clock, entries } = setUp(adapter, { "send-email": queue<{ to: string }>(({ payload }) => ({ sentTo: payload.to })) });
    for (const to of ["a", "b", "c"]) await store.enqueue("send-email", { to }, {});
    store.start({} as never);
    await until(async () => (await all(adapter)).every((row) => row.status === "completed"), clock);
    const rows = await all(adapter);
    expect(rows.map((row) => [row.status, row.attempt, row.worker, row.result])).toEqual([
      ["completed", 1, "test:1", { sentTo: "a" }],
      ["completed", 1, "test:1", { sentTo: "b" }],
      ["completed", 1, "test:1", { sentTo: "c" }],
    ]);
    expect(entries.filter((entry) => entry.message === "queue.message.completed")).toHaveLength(3);
    expect(entries.find((entry) => entry.message === "queue.message.started")).toMatchObject({ queue: "send-email", attempt: 1 });
    store.stop();
    await store.drain(0);
    expect(clock.timers()).toBe(0);
  });

  test("a worker losing the conditional update tries the next candidate, and two workers run each message once", async () => {
    const adapter = await memory();
    const ran: string[] = [];
    const definitions = { jobs: queue<{ n: number }>(({ payload }) => void ran.push(String(payload.n))) };
    const one = setUp(adapter, definitions, { worker: "one:1" });
    const first = await one.store.enqueue("jobs", { n: 0 }, {});
    await one.store.enqueue("jobs", { n: 1 }, {});
    // Another worker claims the first candidate between this worker's read and its update.
    const update = adapter.updateById.bind(adapter);
    let stolen = false;
    adapter.updateById = async (entity, id, changes, where) => {
      if (changes.status === "active" && id === first.id && !stolen) {
        stolen = true;
        await update(entity, id, { ...changes, worker: "other:0" }, where);
      }
      return update(entity, id, changes, where);
    };
    one.store.start({} as never);
    await until(async () => ran.length === 1, one.clock);
    const rows = await all(adapter);
    expect(rows.map((row) => [row.status, row.worker])).toEqual([
      ["active", "other:0"],
      ["completed", "one:1"],
    ]);
    expect(ran).toEqual(["1"]);
    one.store.stop();
    adapter.updateById = update;

    const shared = await memory();
    const counts = new Map<number, number>();
    const counting = { jobs: queue<{ n: number }>(({ payload }) => void counts.set(payload.n, (counts.get(payload.n) ?? 0) + 1)) };
    const a = setUp(shared, counting, { worker: "a:1", concurrency: 3 });
    const b = setUp(shared, counting, { worker: "b:2", concurrency: 3, clock: a.clock });
    for (let n = 0; n < 20; n++) await a.store.enqueue("jobs", { n }, {});
    a.store.start({} as never);
    b.store.start({} as never);
    await until(async () => (await all(shared)).every((row) => row.status === "completed"), a.clock);
    expect(counts.size).toBe(20);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    a.store.stop();
    b.store.stop();
  });

  const shared: [string, () => Promise<[DatabaseAdapter, DatabaseAdapter, () => Promise<void>]>][] = [
    [
      "sqlite",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "qs-queue-"));
        const path = join(dir, "db.sqlite");
        const first = sqliteAdapter({ path });
        await first.connect([model]);
        await createSqliteTables(first.client!, [model]);
        const second = sqliteAdapter({ path });
        await second.connect([model]);
        return [first, second, async () => rmSync(dir, { recursive: true, force: true })];
      },
    ],
  ];
  if (process.env.TEST_POSTGRES_URL) {
    shared.push([
      "postgres",
      async () => {
        const first = postgresAdapter({ url: process.env.TEST_POSTGRES_URL! });
        await first.connect([model]);
        await resetPostgresTables(first.client!, [model]);
        const second = postgresAdapter({ url: process.env.TEST_POSTGRES_URL! });
        await second.connect([model]);
        return [first, second, async () => {}];
      },
    ]);
  }
  for (const [name, open] of shared) {
    test(`${name}: two instances on one database run each of 100 messages exactly once`, async () => {
      const [first, second, cleanup] = await open();
      const runs = new Map<number, number>();
      const definitions = { work: queue<{ n: number }>(async ({ payload }) => void runs.set(payload.n, (runs.get(payload.n) ?? 0) + 1)) };
      const a = setUp(first, definitions, { worker: "a:1", concurrency: 4, clock: systemClock as never });
      const b = setUp(second, definitions, { worker: "b:2", concurrency: 4, clock: systemClock as never });
      try {
        for (let n = 0; n < 100; n++) await a.store.enqueue("work", { n }, {});
        a.store.start({} as never);
        b.store.start({} as never);
        await until(async () => (await all(first)).every((row) => row.status === "completed"));
        expect(runs.size).toBe(100);
        expect([...runs.values()].every((count) => count === 1)).toBe(true);
        const workers = new Set((await all(first)).map((row) => row.worker));
        expect(workers.size).toBeGreaterThanOrEqual(1);
      } finally {
        a.store.stop();
        b.store.stop();
        await a.store.drain(0);
        await b.store.drain(0);
        await first.disconnect();
        await second.disconnect();
        await cleanup();
      }
    }, 30_000);
  }
});

describe("concurrency, polling and wake-up", () => {
  test("at most concurrency messages run at once, an idle loop polls every pollInterval, and a local add wakes it", async () => {
    const adapter = await memory();
    let current = 0;
    let peak = 0;
    const clockRef: { clock?: FakeClock } = {};
    const definitions = {
      slow: queue(async () => {
        current++;
        peak = Math.max(peak, current);
        await clockRef.clock!.sleep(1000);
        current--;
      }),
    };
    const { store, clock } = setUp(adapter, definitions, { concurrency: 2 });
    clockRef.clock = clock;
    for (let n = 0; n < 5; n++) await store.enqueue("slow", {}, {});
    let reads = 0;
    const findMany = adapter.findMany.bind(adapter);
    adapter.findMany = (entity, options) => {
      if (options.where.some((condition) => "field" in condition && condition.field === "queue")) reads++;
      return findMany(entity, options);
    };
    store.start({} as never);
    await clock.flush();
    expect(current).toBe(2);
    await clock.advance(5000);
    expect(peak).toBe(2);
    expect((await all(adapter)).every((row) => row.status === "completed")).toBe(true);
    // Idle: one read per pollInterval.
    const before = reads;
    await clock.advance(3000);
    expect(reads - before).toBe(3);
    // A local add is claimed before the next poll.
    await clock.advance(200);
    await store.enqueue("slow", {}, {});
    await clock.flush();
    expect(current).toBe(1);
    await clock.advance(1000);
    store.stop();
    await store.drain(0);
    expect(clock.timers()).toBe(0);
  });
});

describe("records", () => {
  test("a failing handler stores lastError with a stack outside production, a too large result is not stored", async () => {
    const adapter = await memory();
    const definitions = {
      fail: queue(() => {
        throw new Error("smtp down");
      }),
      big: queue(() => "x".repeat(100)),
    };
    const dev = setUp(adapter, definitions, { resultLimit: 50 });
    await dev.store.enqueue("fail", {}, {});
    await dev.store.enqueue("big", {}, {});
    dev.store.start({} as never);
    await until(async () => (await all(adapter)).every((row) => row.status !== "waiting" && row.status !== "active"), dev.clock);
    const [failed, big] = await all(adapter);
    expect(failed).toMatchObject({ status: "dead", lastError: { message: "smtp down", stack: expect.stringContaining("smtp down") } });
    expect(failed!.finishedAt).toBeInstanceOf(Date);
    expect(big!.status).toBe("completed");
    expect(big!.result ?? undefined).toBeUndefined();
    expect(dev.entries.find((entry) => entry.message === "queue.message.failed")).toMatchObject({ queue: "fail", messageId: failed!.id, attempt: 1, durationMs: expect.any(Number), error: { message: "smtp down" } });
    expect(dev.entries.find((entry) => entry.message === "Result larger than 50 bytes was not stored")).toMatchObject({ queue: "big", messageId: big!.id });
    dev.store.stop();

    const production = await memory();
    const prod = setUp(production, definitions, { production: true });
    await prod.store.enqueue("fail", {}, {});
    prod.store.start({} as never);
    await until(async () => (await all(production))[0]!.status === "dead", prod.clock);
    expect((await all(production))[0]!.lastError).toEqual({ message: "smtp down" });
    prod.store.stop();
  });

  test("ctx.log writes to the service logger with the queue and message id", async () => {
    const adapter = await memory();
    const { store, clock, entries } = setUp(adapter, { logs: queue(({ log }) => log.info("sending", { to: "a" })) });
    const { id } = await store.enqueue("logs", {}, {});
    store.start({} as never);
    await until(async () => (await all(adapter))[0]!.status === "completed", clock);
    expect(entries.find((entry) => entry.message === "sending")).toMatchObject({ level: "info", to: "a", queue: "logs", messageId: id });
    store.stop();
  });
});

describe("leases", () => {
  test("a long handler keeps its lease, and an expired lease of a stopped instance is reclaimed and run again", async () => {
    const adapter = await memory();
    const clockRef: { clock?: FakeClock } = {};
    const { store, clock, entries } = setUp(adapter, { long: queue(async () => clockRef.clock!.sleep(5000)) }, { timeout: "3s" });
    clockRef.clock = clock;
    await store.enqueue("long", {}, {});
    store.start({} as never);
    await clock.flush();
    const first = (await all(adapter))[0]!;
    expect(first.lockedUntil!.getTime()).toBe(clock.now() + 3000);
    await clock.advance(2000);
    expect((await all(adapter))[0]!.lockedUntil!.getTime()).toBeGreaterThan(first.lockedUntil!.getTime());
    await clock.advance(3000);
    expect((await all(adapter))[0]!.status).toBe("completed");
    store.stop();

    // A message left active by an instance that stopped.
    const stale = await memory();
    const now = clock.now();
    await stale.insert(model, { id: Bun.randomUUIDv7(), createdAt: new Date(now), updatedAt: new Date(now), queue: "long", payload: {}, status: "active", priority: 0, runAt: new Date(now - 60_000), attempt: 1, maxAttempts: 4, enqueuedAt: new Date(now - 60_000), worker: "gone:9", lockedUntil: new Date(now + 30_000), startedAt: new Date(now - 60_000) });
    const ran: number[] = [];
    const next = setUp(stale, { long: queue(({ message }) => void ran.push(message.attempt)) }, { clock });
    next.store.start({} as never);
    await clock.flush();
    expect(ran).toEqual([]);
    await clock.advance(RECLAIM_INTERVAL);
    await until(async () => (await all(stale))[0]!.status === "completed", clock);
    expect(ran).toEqual([2]);
    expect(next.entries.find((entry) => entry.message === "queue.message.reclaimed")).toMatchObject({ queue: "long", attempt: 1 });
    next.store.stop();
    await next.store.drain(0);
    expect(entries.some((entry) => entry.message === "queue.message.reclaimed")).toBe(false);
  });
});

describe("shutdown", () => {
  test("stop ends claiming, drain aborts the signal, waits the grace and returns a still running message uncounted", async () => {
    const adapter = await memory();
    let aborted: unknown;
    const { store, clock } = setUp(adapter, {
      stubborn: queue(({ signal }) => {
        signal.addEventListener("abort", () => (aborted = signal.reason));
        return new Promise(() => {});
      }),
    });
    await store.enqueue("stubborn", {}, {});
    store.start({} as never);
    await clock.flush();
    expect((await all(adapter))[0]).toMatchObject({ status: "active", attempt: 1 });
    store.stop();
    const draining = store.drain(2000);
    await clock.flush();
    expect((aborted as Error).name).toBe("AbortError");
    await clock.advance(2000);
    await draining;
    expect((await all(adapter))[0]).toMatchObject({ status: "waiting", attempt: 0, worker: null, lockedUntil: null });
    expect(clock.timers()).toBe(0);
  });
});
