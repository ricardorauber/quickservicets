import { describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { brokerName, createConsumerPool, createDedupeStore, decodeQueueMessage, encodeQueueMessage, nextRetryAt, QueueBrokerError, queueDedupeEntity, type QueueEnvelope } from "./features/queues/kit.ts";
import type { QueueReceivedMessage } from "./features/queues/broker.ts";
import { configureTransactions, transaction } from "./transactions.ts";

const NOW = Date.parse("2026-11-03T10:00:00Z");

describe("the envelope", () => {
  test("encoding and decoding gives back the message; another version, bad JSON and a missing field are refused", () => {
    const message: QueueEnvelope = {
      id: "m1",
      queue: "billing/close",
      payload: { invoice: 1 },
      priority: 5,
      runAt: new Date(NOW),
      attempt: 2,
      maxAttempts: 4,
      dedupeKey: "k1",
      tenant: "acme",
      requestId: "r1",
      enqueuedAt: new Date(NOW - 1000),
      trace: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    };
    const text = encodeQueueMessage(message);
    expect(JSON.parse(text)).toMatchObject({ v: 1, runAt: "2026-11-03T10:00:00.000Z" });
    expect(decodeQueueMessage(text)).toEqual(message);
    expect(() => decodeQueueMessage('{"v":2}')).toThrow("Invalid queue message: unsupported version 2");
    expect(() => decodeQueueMessage("nope")).toThrow("Invalid queue message: not JSON");
    const { id: _id, ...withoutId } = JSON.parse(text) as Record<string, unknown>;
    expect(() => decodeQueueMessage(JSON.stringify(withoutId))).toThrow("Invalid queue message: missing id");
  });
});

describe("retry times", () => {
  test("the doubled delay with ±10% jitter, capped at the longest, and null once attempts ran out", () => {
    const options = { retryDelay: "10s", maxRetryDelay: "1h" };
    for (const random of [0, 0.5, 1, Math.random()]) {
      const at = nextRetryAt(3, options, NOW, () => random)!.getTime() - NOW;
      expect(at).toBeGreaterThanOrEqual(36_000);
      expect(at).toBeLessThanOrEqual(44_000);
      const capped = nextRetryAt(20, options, NOW, () => random)!.getTime() - NOW;
      expect(capped).toBeGreaterThanOrEqual(3_240_000);
      expect(capped).toBeLessThanOrEqual(3_960_000);
    }
    expect(nextRetryAt(4, { ...options, maxAttempts: 4 }, NOW)).toBeNull();
    expect(nextRetryAt(3, { ...options, maxAttempts: 4 }, NOW)).toBeInstanceOf(Date);
  });
});

describe("the dedupe store", () => {
  async function setUp() {
    const adapter = memoryAdapter();
    await adapter.connect([queueDedupeEntity]);
    configureTransactions(adapter);
    const clock = { now: NOW };
    return { adapter, clock, store: createDedupeStore({ adapter, now: () => clock.now }) };
  }

  test("one of two concurrent claims wins; release frees the key, or keeps it for a window", async () => {
    const { store, clock } = await setUp();
    const [a, b] = await Promise.all([store.claim({ queue: "q", dedupeKey: "k", messageId: "m1" }), store.claim({ queue: "q", dedupeKey: "k", messageId: "m2" })]);
    const results = [a, b];
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    const winner = a.claimed ? "m1" : "m2";
    expect(results.find((result) => !result.claimed)).toEqual({ claimed: false, messageId: winner });
    await store.release({ queue: "q", dedupeKey: "k", messageId: winner });
    expect(await store.claim({ queue: "q", dedupeKey: "k", messageId: "m3" })).toEqual({ claimed: true });
    await store.release({ queue: "q", dedupeKey: "k", messageId: "m3", window: "1h" });
    expect(await store.claim({ queue: "q", dedupeKey: "k", messageId: "m4" })).toEqual({ claimed: false, messageId: "m3" });
    clock.now += 3_600_001;
    expect(await store.cleanup()).toBe(1);
    expect(await store.claim({ queue: "q", dedupeKey: "k", messageId: "m4" })).toEqual({ claimed: true });
  });

  test("an expired slot counts as free, and a claim inside a rolled-back transaction leaves no slot", async () => {
    const { store, clock, adapter } = await setUp();
    await store.claim({ queue: "q", dedupeKey: "old", messageId: "m1" });
    await store.release({ queue: "q", dedupeKey: "old", messageId: "m1", window: "1m" });
    clock.now += 61_000;
    expect(await store.claim({ queue: "q", dedupeKey: "old", messageId: "m2" })).toEqual({ claimed: true });
    await expect(
      transaction(async () => {
        await store.claim({ queue: "q", dedupeKey: "tx", messageId: "m5" });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await adapter.count(queueDedupeEntity, [{ field: "slot", op: "eq", value: "q:tx" } as never])).toBe(0);
  });
});

describe("the consumer pool", () => {
  const message = (id: string): QueueReceivedMessage => ({ id, queue: "q", payload: id, attempt: 1, enqueuedAt: new Date() });

  test("at most the queue's concurrency runs, push waits while it is full, ack and nack follow the outcome, drain waits", async () => {
    let active = 0;
    let most = 0;
    const acks: string[] = [];
    const nacks: string[] = [];
    const pool = createConsumerPool({
      queues: [{ name: "q", options: { concurrency: 2 } }],
      async handle(received) {
        active++;
        most = Math.max(most, active);
        await Bun.sleep(30);
        active--;
        return received.id.startsWith("bad") ? { failed: new Error("no") } : { completed: true };
      },
    });
    const pushed: number[] = [];
    const pushes = ["a", "b", "bad-c", "d"].map((id, index) => pool.push("q", message(id), { ack: () => void acks.push(id), nack: () => void nacks.push(id) }).then(() => pushed.push(index)));
    await Bun.sleep(5);
    // Two started; the other two wait for room.
    expect(pushed.sort()).toEqual([0, 1]);
    expect(pool.active("q")).toBe(2);
    await Promise.all(pushes);
    await pool.drain(1000);
    expect(most).toBe(2);
    expect(acks.sort()).toEqual(["a", "b", "d"]);
    expect(nacks).toEqual(["bad-c"]);
  });

  test("drain resolves after the grace when a handler keeps running, aborting it", async () => {
    let aborted = false;
    const pool = createConsumerPool({
      queues: [{ name: "q", options: { concurrency: 1 } }],
      handle: (_received, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ failed: signal.reason });
          });
        }),
    });
    await pool.push("q", message("slow"), { ack() {}, nack() {} });
    const started = Date.now();
    await pool.drain(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(aborted).toBe(true);
  });
});

describe("names and errors", () => {
  test("queue names map to broker names; a name too long is refused; broker errors carry the broker and cause", () => {
    expect(brokerName("billing/close", "quickservicets.")).toBe("quickservicets.billing.close");
    expect(brokerName("emails")).toBe("quickservicets.emails");
    expect(() => brokerName("x".repeat(260), "quickservicets.")).toThrow(`Queue name ${"x".repeat(260)} is not valid for brokers`);
    const cause = new Error("connection refused");
    const error = new QueueBrokerError("rabbitmq is unreachable", { broker: "rabbitmq", cause });
    expect(error).toMatchObject({ name: "QueueBrokerError", broker: "rabbitmq", cause, message: "rabbitmq is unreachable" });
  });
});
