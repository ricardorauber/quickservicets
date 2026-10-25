import { describe, expect, test } from "bun:test";
import type { JobClock } from "../jobs/scheduler.ts";
import type { QueueBroker, QueueBrokerMessage, QueueOutcome, QueueReceivedMessage, QueueSettings } from "../features/queues/broker.ts";
import { memoryAdapter } from "../adapters/memory.ts";
import { runInTransaction } from "../transactions.ts";

/** What `runQueueBrokerContract` takes besides the broker factory. */
export interface QueueBrokerContractOptions {
  /** Shown in the test titles (default: the broker's `name`). */
  name?: string;
  /**
   * Runs `fn` in a database transaction that the broker's `enqueue` joins or defers to (default: a transaction of a
   * memory adapter, which a broker that cannot join a database transaction defers to with `afterCommit`).
   */
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Milliseconds the tests wait in real time, twice, for the broker's I/O after each timer of the fake clock (default 1). */
  ioWait?: number;
}

/** A clock whose timers fire only when the contract advances it, waiting for real I/O between steps. */
export function contractClock(ioWait = 1) {
  let now = Date.parse("2026-11-02T10:00:00.000Z");
  let sequence = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => {
    for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, ioWait));
  };
  const clock = {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++sequence;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    sleep: (ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, ms)),
    settle,
    /** Moves the time forward, firing each due timer in order and waiting for the broker's I/O after each one. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await settle();
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = target;
      await settle();
    },
  } satisfies JobClock & Record<string, unknown>;
  return clock;
}

type ContractClock = ReturnType<typeof contractClock>;
type Behavior = (message: QueueReceivedMessage, signal: AbortSignal) => unknown;

const SETTINGS: QueueSettings = { concurrency: 1, timeout: "5m", retries: 0, retryDelay: "10s", maxRetryDelay: "1h" };

/** One run of a contract check: a fresh broker started on uniquely named queues with a fake clock. */
async function harness(createBroker: () => QueueBroker | Promise<QueueBroker>, options: QueueBrokerContractOptions) {
  const broker = await createBroker();
  const clock = contractClock(options.ioWait);
  const prefix = `contract-${Bun.randomUUIDv7().slice(-8)}`;
  const handled: { queue: string; message: QueueReceivedMessage; at: number }[] = [];
  const behaviors = new Map<string, Behavior>();
  const settingsByQueue = new Map<string, QueueSettings>();
  const transaction = options.transaction ?? (() => {
    const adapter = memoryAdapter();
    let connected: Promise<void> | undefined;
    return async <T>(fn: () => Promise<T>) => {
      await (connected ??= adapter.connect([]));
      return runInTransaction(adapter, fn);
    };
  })();
  const queue = (name: string, settings: Partial<QueueSettings> = {}, behavior: Behavior = () => "done") => {
    const full = `${prefix}-${name}`;
    settingsByQueue.set(full, { ...SETTINGS, ...settings });
    behaviors.set(full, behavior);
    return full;
  };
  const start = () =>
    broker.start({
      queues: [...settingsByQueue].map(([name, settings]) => ({ name, options: settings })),
      handle: async (message, { signal }): Promise<QueueOutcome> => {
        handled.push({ queue: message.queue, message, at: clock.now() });
        try {
          return { completed: true, result: await behaviors.get(message.queue)!(message, signal) };
        } catch (error) {
          return { failed: error };
        }
      },
      report: () => {},
      pollInterval: "1s",
      logger: { info() {}, warn() {}, error() {} },
      clock,
    });
  const enqueue = (name: string, payload: unknown = {}, extra: Partial<QueueBrokerMessage> = {}, transactional = false) =>
    broker.enqueue(
      { queue: name, payload, runAt: new Date(clock.now()), priority: 0, maxAttempts: (settingsByQueue.get(name)?.retries ?? 0) + 1, ...extra },
      { transactional },
    );
  const until = async (check: () => boolean | Promise<boolean>, limitMs = 60_000) => {
    for (let waited = 0; waited <= limitMs; waited += 100) {
      if (await check()) return;
      await clock.advance(100);
    }
    throw new Error("The broker did not reach the expected state in time");
  };
  const stop = () => broker.stop({ graceMs: 1000 });
  return { broker, clock, handled, queue, start, enqueue, until, stop, transaction, of: (name: string) => handled.filter((entry) => entry.queue === name) };
}

/** One behavior every broker must have, or that a broker with an optional method must have. */
export interface QueueBrokerCheck {
  name: string;
  /** The optional method the check needs; skipped for brokers without it. */
  needs?: "retry" | "retryDead" | "dead" | "cleanup" | "health";
  run(createBroker: () => QueueBroker | Promise<QueueBroker>, options: QueueBrokerContractOptions): Promise<void>;
}

/** The checks `runQueueBrokerContract` registers, in order. */
export const QUEUE_BROKER_CHECKS: readonly QueueBrokerCheck[] = [
  {
    name: "enqueues messages and hands each to its consumer once",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const work = h.queue("work");
      await h.start();
      try {
        const ids = [];
        for (const n of [1, 2, 3]) ids.push((await h.enqueue(work, { n })).id);
        expect(new Set(ids).size).toBe(3);
        await h.until(() => h.of(work).length >= 3);
        await h.clock.advance(2000);
        expect(h.of(work).map((entry) => entry.message.payload).sort((a, b) => (a as { n: number }).n - (b as { n: number }).n)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
        expect(h.of(work).map((entry) => entry.message.attempt)).toEqual([1, 1, 1]);
        expect(new Set(h.of(work).map((entry) => entry.message.id))).toEqual(new Set(ids));
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "runs at most concurrency messages of a queue at once",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      let current = 0;
      let peak = 0;
      const slow = h.queue("slow", { concurrency: 2 }, async () => {
        current++;
        peak = Math.max(peak, current);
        await h.clock.sleep(1000);
        current--;
      });
      await h.start();
      try {
        for (let n = 0; n < 5; n++) await h.enqueue(slow, { n });
        await h.until(() => h.of(slow).length >= 5 && current === 0);
        expect(peak).toBe(2);
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "retries a failed message with exponential backoff",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const flaky = h.queue("flaky", { retries: 2, retryDelay: "10s" }, (message) => {
        if (message.attempt < 3) throw new Error(`attempt ${message.attempt} failed`);
      });
      await h.start();
      try {
        const start = h.clock.now();
        await h.enqueue(flaky);
        await h.until(() => h.of(flaky).length >= 3);
        const [first, second, third] = h.of(flaky);
        expect([first!.message.attempt, second!.message.attempt, third!.message.attempt]).toEqual([1, 2, 3]);
        // 10s, then 20s more, each within a 10% jitter and the poll interval.
        expect(second!.at - first!.at).toBeGreaterThanOrEqual(9000);
        expect(second!.at - first!.at).toBeLessThanOrEqual(13_000);
        expect(third!.at - second!.at).toBeGreaterThanOrEqual(18_000);
        expect(third!.at - second!.at).toBeLessThanOrEqual(24_000);
        expect(first!.at - start).toBeLessThanOrEqual(2000);
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "runs a delayed message once its time has come",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const later = h.queue("later");
      await h.start();
      try {
        await h.enqueue(later, {}, { runAt: new Date(h.clock.now() + 300_000) });
        await h.clock.advance(240_000);
        expect(h.of(later)).toHaveLength(0);
        await h.until(() => h.of(later).length === 1, 90_000);
        expect(h.of(later)[0]!.at).toBeGreaterThanOrEqual(Date.parse("2026-11-02T10:05:00.000Z"));
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "runs higher priorities first",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const release = Promise.withResolvers<void>();
      const ordered = h.queue("ordered", {}, async (message) => {
        if ((message.payload as { name: string }).name === "blocker") await release.promise;
      });
      await h.start();
      try {
        await h.enqueue(ordered, { name: "blocker" });
        await h.until(() => h.of(ordered).length === 1);
        for (const [name, priority] of [["zero", 0], ["ten", 10], ["minus-five", -5]] as const) await h.enqueue(ordered, { name }, { priority });
        await h.clock.settle();
        release.resolve();
        await h.until(() => h.of(ordered).length === 4);
        expect(h.of(ordered).map((entry) => (entry.message.payload as { name: string }).name)).toEqual(["blocker", "ten", "zero", "minus-five"]);
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "deduplicates messages of a queue by key while they are live",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const keyed = h.queue("keyed");
      // Not started: the first message stays live.
      const first = await h.enqueue(keyed, {}, { dedupeKey: "order-1" });
      const second = await h.enqueue(keyed, {}, { dedupeKey: "order-1" });
      expect(first.deduplicated).toBe(false);
      expect(second).toEqual({ id: first.id, deduplicated: true });
      expect((await h.enqueue(keyed, {}, { dedupeKey: "order-2" })).deduplicated).toBe(false);
      await h.stop();
    },
  },
  {
    name: "publishes nothing for an enqueue in a rolled-back transaction, and the message after a commit",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const tx = h.queue("tx");
      await h.start();
      try {
        await expect(
          h.transaction(async () => {
            await h.enqueue(tx, { kept: false }, {}, true);
            throw new Error("rolled back");
          }),
        ).rejects.toThrow("rolled back");
        await h.transaction(() => h.enqueue(tx, { kept: true }, {}, true));
        await h.until(() => h.of(tx).length >= 1);
        await h.clock.advance(3000);
        expect(h.of(tx).map((entry) => entry.message.payload)).toEqual([{ kept: true }]);
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "stop waits for running messages and takes no new ones",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      let finished = false;
      const slow = h.queue("draining", {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        finished = true;
      });
      await h.start();
      await h.enqueue(slow, { n: 1 });
      await h.until(() => h.of(slow).length === 1);
      await h.broker.stop({ graceMs: 5000 });
      expect(finished).toBe(true);
      await h.enqueue(slow, { n: 2 });
      await h.clock.advance(5000);
      expect(h.of(slow)).toHaveLength(1);
    },
  },
  {
    name: "stats counts the waiting messages of a queue",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const counted = h.queue("counted");
      await h.enqueue(counted, {}, { runAt: new Date(h.clock.now() + 3_600_000) });
      await h.enqueue(counted, {}, { runAt: new Date(h.clock.now() + 3_600_000) });
      const stats = await h.broker.stats();
      expect(stats[counted]).toMatchObject({ waiting: 2 });
      await h.stop();
    },
  },
  {
    name: "a message failing its last attempt ends dead",
    needs: "dead",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const failing = h.queue("failing", { retries: 0 }, () => {
        throw new Error("always");
      });
      await h.start();
      try {
        const { id } = await h.enqueue(failing);
        await h.until(async () => (await h.broker.dead!(failing, { limit: 10 })).length === 1);
        expect((await h.broker.dead!(failing, { limit: 10 })).map((message) => message.id)).toEqual([id]);
        expect((await h.broker.stats())[failing]).toMatchObject({ dead: 1 });
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "retry runs a dead message again",
    needs: "retry",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      let fail = true;
      const failing = h.queue("retried", { retries: 0 }, () => {
        if (fail) throw new Error("once");
      });
      await h.start();
      try {
        const { id } = await h.enqueue(failing);
        await h.until(() => h.of(failing).length === 1);
        await h.clock.advance(2000);
        fail = false;
        await h.broker.retry!(id);
        await h.until(() => h.of(failing).length === 2);
        expect(h.of(failing)[1]!.message.attempt).toBe(1);
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "retryDead requeues every dead message of a queue",
    needs: "retryDead",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      let fail = true;
      const failing = h.queue("requeued", { retries: 0, concurrency: 2 }, () => {
        if (fail) throw new Error("twice");
      });
      await h.start();
      try {
        await h.enqueue(failing);
        await h.enqueue(failing);
        await h.until(() => h.of(failing).length === 2);
        await h.clock.advance(2000);
        fail = false;
        expect(await h.broker.retryDead!(failing)).toBe(2);
        await h.until(() => h.of(failing).length === 4);
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "cleanup resolves with the numbers of deleted messages",
    needs: "cleanup",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      const result = await h.broker.cleanup!();
      expect(typeof result.completed).toBe("number");
      expect(typeof result.dead).toBe("number");
      await h.stop();
    },
  },
  {
    name: "health resolves while the broker can take messages",
    needs: "health",
    async run(createBroker, options) {
      const h = await harness(createBroker, options);
      await h.broker.health!();
      await h.stop();
    },
  },
];

/**
 * Registers the `bun:test` tests every `QueueBroker` must pass: enqueue and processing, concurrency, retries with
 * backoff, delay, priority, dedupe, rollback, stopping and stats, and the tests of the optional methods the broker has.
 * `createBroker` returns a fresh broker over an empty or shared store; each test uses queues of its own.
 */
export function runQueueBrokerContract(createBroker: () => QueueBroker | Promise<QueueBroker>, options: QueueBrokerContractOptions = {}): void {
  // A broker created at once tells which optional methods it has, so the tests of the others are skipped.
  const sample = createBroker();
  const known = sample instanceof Promise ? undefined : sample;
  if (known) void known.stop({ graceMs: 0 });
  describe(`${options.name ?? known?.name ?? "queue"} broker contract`, () => {
    for (const check of QUEUE_BROKER_CHECKS) {
      const lacking = check.needs !== undefined && known !== undefined && typeof known[check.needs] !== "function";
      test.skipIf(lacking)(check.name, async () => {
        if (check.needs) {
          const broker = await createBroker();
          const has = typeof broker[check.needs] === "function";
          await broker.stop({ graceMs: 0 });
          if (!has) return;
        }
        await check.run(createBroker, options);
      }, 60_000);
    }
  });
}
