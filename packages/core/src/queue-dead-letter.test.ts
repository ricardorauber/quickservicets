import { describe, expect, test } from "bun:test";
import { queue } from "./features/queues/queue.ts";
import { all, memory, model, setUp, until } from "./queue-test-support.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import "./index.ts";

const DAY = 86_400_000;

/** Inserts a message as another process left it. */
async function insert(adapter: DatabaseAdapter, fields: Record<string, unknown>) {
  const now = new Date();
  const id = Bun.randomUUIDv7();
  await adapter.insert(model, { id, createdAt: now, updatedAt: now, queue: "send-email", payload: {}, status: "waiting", priority: 0, runAt: now, attempt: 0, maxAttempts: 4, enqueuedAt: now, ...fields } as never);
  return id;
}

describe("dead messages", () => {
  test("a message failing every attempt ends dead, logs queue.message.dead and is never run again", async () => {
    const adapter = await memory();
    let runs = 0;
    const { store, clock, entries } = setUp(
      adapter,
      {
        "send-email": queue(() => {
          runs++;
          throw new Error("smtp down");
        }),
      },
      { retries: 1, retryDelay: "1s", random: () => 0.5 },
    );
    const { id } = await store.enqueue("send-email", { to: "a" }, {});
    store.start({} as never);
    await clock.advance(10_000);
    expect(runs).toBe(2);
    expect((await all(adapter))[0]).toMatchObject({ id, status: "dead", attempt: 2, payload: { to: "a" }, lastError: { message: "smtp down" } });
    expect(entries.filter((entry) => entry.message === "queue.message.dead")).toEqual([
      expect.objectContaining({ level: "error", queue: "send-email", messageId: id, attempt: 2, error: { message: "smtp down" } }),
    ]);
    await clock.advance(120_000);
    expect(runs).toBe(2);
    store.stop();
  });
});

describe("retry and retryDead", () => {
  test("retry runs a dead message again from attempt 1; other statuses and unknown ids throw", async () => {
    const adapter = await memory();
    const attempts: number[] = [];
    let fail = true;
    const { store, clock } = setUp(
      adapter,
      {
        "send-email": queue(({ message }) => {
          attempts.push(message.attempt);
          if (fail) throw new Error("smtp down");
        }),
      },
      { retries: 0 },
    );
    const { id } = await store.enqueue("send-email", {}, {});
    store.start({} as never);
    await until(async () => (await all(adapter))[0]!.status === "dead", clock);
    fail = false;
    await store.retry(id);
    await until(async () => (await all(adapter))[0]!.status === "completed", clock);
    expect(attempts).toEqual([1, 1]);
    expect((await all(adapter))[0]).toMatchObject({ status: "completed", attempt: 1 });
    await expect(store.retry(id)).rejects.toThrow(`Queue message ${id} is not dead`);
    await expect(store.retry("nope")).rejects.toThrow("Queue message nope not found");
    store.stop();

    const other = await memory();
    const waiting = await insert(other, { status: "waiting" });
    const active = await insert(other, { status: "active", attempt: 1 });
    const dead = await insert(other, { status: "dead", attempt: 4, lastError: { message: "gone" }, finishedAt: new Date() });
    const idle = setUp(other, {});
    await expect(idle.store.retry(waiting)).rejects.toThrow(`Queue message ${waiting} is not dead`);
    await expect(idle.store.retry(active)).rejects.toThrow(`Queue message ${active} is not dead`);
    await idle.store.retry(dead);
    // lastError stays until the next run.
    expect((await all(other)).find((row) => row.id === dead)).toMatchObject({ status: "waiting", attempt: 0, lastError: { message: "gone" }, finishedAt: null });
  });

  test("retryDead requeues every dead message of a queue and returns the count", async () => {
    const adapter = await memory();
    for (let n = 0; n < 3; n++) await insert(adapter, { status: "dead", attempt: 4, finishedAt: new Date() });
    await insert(adapter, { status: "dead", attempt: 4, finishedAt: new Date(), queue: "other" });
    await insert(adapter, { status: "completed", attempt: 1, finishedAt: new Date() });
    const { store } = setUp(adapter, {});
    expect(await store.retryDead("send-email")).toBe(3);
    expect(await store.retryDead("send-email")).toBe(0);
    expect((await all(adapter)).map((row) => `${row.queue}:${row.status}`).sort()).toEqual(["other:dead", "send-email:completed", "send-email:waiting", "send-email:waiting", "send-email:waiting"]);
  });
});

describe("listing", () => {
  test("stats counts each queue's messages by status, dead lists the latest dead messages", async () => {
    const adapter = await memory();
    const now = Date.now();
    await insert(adapter, { status: "waiting", enqueuedAt: new Date(now - 5000) });
    await insert(adapter, { status: "waiting", enqueuedAt: new Date(now - 1000) });
    const older = await insert(adapter, { status: "dead", attempt: 4, finishedAt: new Date(now - 2000), lastError: { message: "first" } });
    const latest = await insert(adapter, { status: "dead", attempt: 4, finishedAt: new Date(now - 1000), lastError: { message: "second" } });
    const { store } = setUp(adapter, { "send-email": queue(() => {}), quiet: queue(() => {}) });
    expect(await store.stats()).toEqual({
      quiet: { waiting: 0, active: 0, completed: 0, dead: 0, oldestWaiting: null },
      "send-email": { waiting: 2, active: 0, completed: 0, dead: 2, oldestWaiting: new Date(now - 5000) },
    });
    expect((await store.dead("send-email", { limit: 1 })).map((row) => row.id)).toEqual([latest]);
    expect((await store.dead("send-email")).map((row) => row.id)).toEqual([latest, older]);
  });
});

describe("retention", () => {
  test("cleanup deletes completed messages past 7 days and dead ones past 30, once across instances", async () => {
    const adapter = await memory();
    const { store, clock, entries } = setUp(adapter, {}, { retention: { completed: "7d", dead: "30d" } });
    const now = clock.now();
    const old = await insert(adapter, { status: "completed", finishedAt: new Date(now - 8 * DAY) });
    const recent = await insert(adapter, { status: "completed", finishedAt: new Date(now - 6 * DAY) });
    const deadOld = await insert(adapter, { status: "dead", finishedAt: new Date(now - 31 * DAY) });
    const deadRecent = await insert(adapter, { status: "dead", finishedAt: new Date(now - 29 * DAY) });
    const waiting = await insert(adapter, { status: "waiting", enqueuedAt: new Date(now - 60 * DAY) });
    expect(await store.cleanup()).toEqual({ completed: 1, dead: 1 });
    expect((await all(adapter)).map((row) => row.id).sort()).toEqual([recent, deadRecent, waiting].sort());
    expect(entries.find((entry) => entry.message === "queue.cleanup")).toMatchObject({ completed: 1, dead: 1 });
    expect([old, deadOld].every((id) => id)).toBe(true);

    const many = await memory();
    for (let n = 0; n < 50; n++) await insert(many, { status: "completed", finishedAt: new Date(now - 8 * DAY) });
    const one = setUp(many, {}, { clock });
    const two = setUp(many, {}, { clock });
    const [first, second] = await Promise.all([one.store.cleanup(), two.store.cleanup()]);
    expect(first.completed + second.completed).toBe(50);
    expect(await all(many)).toEqual([]);
  });

  test("a process with consumers cleans at startup and every hour", async () => {
    const adapter = await memory();
    const { store, clock, entries } = setUp(adapter, { "send-email": queue(() => {}) }, { pollInterval: "10m" });
    store.start({} as never);
    await clock.flush();
    expect(entries.filter((entry) => entry.message === "queue.cleanup")).toHaveLength(1);
    await insert(adapter, { status: "completed", finishedAt: new Date(clock.now() - 8 * DAY) });
    await clock.advance(3_600_000);
    expect(entries.filter((entry) => entry.message === "queue.cleanup")).toHaveLength(2);
    expect(await all(adapter)).toEqual([]);
    store.stop();
  });
});
