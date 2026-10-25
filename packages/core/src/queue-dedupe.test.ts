import { describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { messagePlacement } from "./features/queues/message-options.ts";
import { queue } from "./features/queues/queue.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import { runInTransaction } from "./transactions.ts";
import { all, memory, model, setUp, until } from "./queue-test-support.ts";
import "./index.ts";

const keyed = (dedupeKey: string, now = Date.now()) => messagePlacement({ dedupeKey }, now);

describe("keys", () => {
  test("two adds with one key return the same message, the second deduplicated; an empty key throws", async () => {
    const adapter = await memory();
    const { store, entries } = setUp(adapter, { charge: queue(() => {}) });
    const first = await store.enqueue("charge", { amount: 1 }, {}, keyed("order-1"));
    const second = await store.enqueue("charge", { amount: 1 }, {}, keyed("order-1"));
    expect(first).toEqual({ id: expect.any(String), deduplicated: false });
    expect(second).toEqual({ id: first.id, deduplicated: true });
    expect(await all(adapter)).toEqual([expect.objectContaining({ id: first.id, dedupeKey: "order-1", dedupeSlot: "charge:order-1" })]);
    expect(entries.filter((entry) => entry.message === "queue.message.deduplicated")).toEqual([expect.objectContaining({ level: "info", queue: "charge", dedupeKey: "order-1", messageId: first.id })]);
    // Keys are per queue.
    const { store: other } = setUp(adapter, { refund: queue(() => {}) });
    expect((await other.enqueue("refund", {}, {}, keyed("order-1"))).deduplicated).toBe(false);
    expect(() => messagePlacement({ dedupeKey: "" }, 0)).toThrow("Invalid queue options: dedupeKey must be 1 to 255 characters");
    expect(() => messagePlacement({ dedupeKey: "x".repeat(256) }, 0)).toThrow("Invalid queue options: dedupeKey must be 1 to 255 characters");
    expect(() => messagePlacement({ dedupeKey: 7 as never }, 0)).toThrow("Invalid queue options: dedupeKey must be 1 to 255 characters");
    expect(messagePlacement({ dedupeKey: "x".repeat(255) }, 0).dedupeKey).toHaveLength(255);
  });
});

describe("after completion", () => {
  test("a completed message frees its key, unless the queue has a dedupe window still open", async () => {
    const adapter = await memory();
    const { store, clock } = setUp(adapter, { charge: queue(() => {}) });
    const first = await store.enqueue("charge", {}, {}, keyed("order-1", clock.now()));
    store.start({} as never);
    await until(async () => (await all(adapter))[0]!.status === "completed", clock);
    expect((await all(adapter))[0]!.dedupeSlot).toBeNull();
    const third = await store.enqueue("charge", {}, {}, keyed("order-1", clock.now()));
    expect(third.deduplicated).toBe(false);
    expect(third.id).not.toBe(first.id);
    store.stop();

    const windowed = await memory();
    const timed = setUp(windowed, { charge: queue(() => {}) }, { pollInterval: "10m", settings: () => ({ concurrency: 1, timeout: "5m", retries: 3, retryDelay: "10s", maxRetryDelay: "1h", dedupeWindow: "1h" }) });
    const original = await timed.store.enqueue("charge", {}, {}, keyed("order-1", timed.clock.now()));
    timed.store.start({} as never);
    await until(async () => (await all(windowed))[0]!.status === "completed", timed.clock);
    await timed.clock.advance(59 * 60_000);
    expect(await timed.store.enqueue("charge", {}, {}, keyed("order-1", timed.clock.now()))).toEqual({ id: original.id, deduplicated: true });
    await timed.clock.advance(2 * 60_000);
    const after = await timed.store.enqueue("charge", {}, {}, keyed("order-1", timed.clock.now()));
    expect(after.deduplicated).toBe(false);
    expect((await all(windowed)).find((row) => row.id === original.id)!.dedupeSlot).toBeNull();
    timed.store.stop();
  });

  test("a dead message frees its key; retrying it while a newer message holds the key throws", async () => {
    const adapter = await memory();
    const { store, clock } = setUp(adapter, { charge: queue(() => Promise.reject(new Error("declined"))) }, { retries: 0 });
    const dead = await store.enqueue("charge", {}, {}, keyed("order-1", clock.now()));
    store.start({} as never);
    await until(async () => (await all(adapter))[0]!.status === "dead", clock);
    store.stop();
    expect((await all(adapter))[0]!.dedupeSlot).toBeNull();
    const newer = await store.enqueue("charge", {}, {}, keyed("order-1", clock.now()));
    expect(newer.deduplicated).toBe(false);
    await expect(store.retry(dead.id)).rejects.toThrow(`Queue message ${dead.id} has dedupe key order-1 in use by ${newer.id}`);
    expect(await store.retryDead("charge")).toBe(0);
  });

  test("retrying a dead message takes its key back when no live message holds it", async () => {
    const adapter = await memory();
    const { store, clock } = setUp(adapter, { charge: queue(() => Promise.reject(new Error("declined"))) }, { retries: 0 });
    const dead = await store.enqueue("charge", {}, {}, keyed("order-1", clock.now()));
    store.start({} as never);
    await until(async () => (await all(adapter))[0]!.status === "dead", clock);
    store.stop();
    await store.retry(dead.id);
    expect((await all(adapter))[0]).toMatchObject({ status: "waiting", dedupeSlot: "charge:order-1" });
    expect(await store.enqueue("charge", {}, {}, keyed("order-1", clock.now()))).toEqual({ id: dead.id, deduplicated: true });
  });
});

const factories: [string, () => Promise<[DatabaseAdapter, DatabaseAdapter]>][] = [["memory", async () => {
  const adapter = memoryAdapter();
  await adapter.connect([model]);
  return [adapter, adapter];
}], ["sqlite", async () => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/qs-dedupe-${Bun.randomUUIDv7()}.sqlite`;
  const first = sqliteAdapter({ path });
  await first.connect([model]);
  await createSqliteTables(first.client!, [model]);
  const second = sqliteAdapter({ path });
  await second.connect([model]);
  return [first, second];
}]];
if (process.env.TEST_POSTGRES_URL) {
  factories.push(["postgres", async () => {
    const first = postgresAdapter({ url: process.env.TEST_POSTGRES_URL! });
    await first.connect([model]);
    await resetPostgresTables(first.client!, [model]);
    const second = postgresAdapter({ url: process.env.TEST_POSTGRES_URL! });
    await second.connect([model]);
    return [first, second];
  }]);
}
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", async () => {
    const database = `qs_dedupe_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const first = mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database });
    await first.connect([model]);
    await first.createIndexes(model);
    const second = mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database });
    await second.connect([model]);
    return [first, second];
  }]);
}

describe("concurrency", () => {
  for (const [name, open] of factories) {
    test(`${name}: twenty concurrent adds with one key on two instances insert one message`, async () => {
      const [first, second] = await open();
      try {
        const a = setUp(first, { charge: queue(() => {}) });
        const b = setUp(second, { charge: queue(() => {}) });
        const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? a : b).store.enqueue("charge", {}, {}, keyed("order-1"))));
        const rows = await all(first);
        expect(rows).toHaveLength(1);
        expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
        expect(new Set(results.map((result) => result.id))).toEqual(new Set([rows[0]!.id]));
      } finally {
        await first.disconnect();
        if (second !== first) await second.disconnect();
      }
    }, 30_000);

    test(`${name}: an add inside a transaction sees committed messages, and a rolled back add frees the key`, async () => {
      const [first, second] = await open();
      try {
        const a = setUp(first, { charge: queue(() => {}) });
        const b = setUp(second, { charge: queue(() => {}) });
        const committed = await b.store.enqueue("charge", {}, {}, keyed("order-1"));
        const inside = await runInTransaction(first, () => a.store.enqueue("charge", {}, {}, keyed("order-1")));
        expect(inside).toEqual({ id: committed.id, deduplicated: true });
        await expect(
          runInTransaction(first, async () => {
            await a.store.enqueue("charge", {}, {}, keyed("order-2"));
            throw new Error("rolled back");
          }),
        ).rejects.toThrow("rolled back");
        expect((await b.store.enqueue("charge", {}, {}, keyed("order-2"))).deduplicated).toBe(false);
        expect((await all(first)).map((row) => row.dedupeKey).sort()).toEqual(["order-1", "order-2"]);
      } finally {
        await first.disconnect();
        if (second !== first) await second.disconnect();
      }
    }, 30_000);
  }

  if (process.env.TEST_POSTGRES_URL) {
    test("postgres: an add waiting on another transaction's uncommitted message is deduplicated once it commits", async () => {
      const [first, second] = await factories.find(([name]) => name === "postgres")![1]();
      try {
        const a = setUp(first, { charge: queue(() => {}) });
        const b = setUp(second, { charge: queue(() => {}) });
        const held = Promise.withResolvers<void>();
        const added = Promise.withResolvers<string>();
        const holder = runInTransaction(second, async () => {
          added.resolve((await b.store.enqueue("charge", {}, {}, keyed("order-1"))).id);
          await held.promise;
        });
        const holderId = await added.promise;
        const waiting = runInTransaction(first, () => a.store.enqueue("charge", {}, {}, keyed("order-1")));
        await Bun.sleep(100);
        held.resolve();
        await holder;
        expect(await waiting).toEqual({ id: holderId, deduplicated: true });
        expect(await all(first)).toHaveLength(1);
      } finally {
        await first.disconnect();
        await second.disconnect();
      }
    }, 30_000);
  }
});
