import { describe, expect, test } from "bun:test";
import { RECLAIM_INTERVAL } from "./features/queues/database.ts";
import { messagePlacement } from "./features/queues/message-options.ts";
import { queue } from "./features/queues/queue.ts";
import type { FakeClock } from "./jobs/test-support.ts";
import { all, memory, model, setUp, until } from "./queue-test-support.ts";
import "./index.ts";

const failure = (work: () => unknown): Error => {
  try {
    work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("delay and runAt", () => {
  test("options are checked: both delay and runAt, a negative delay, an invalid date and a bad priority throw", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(messagePlacement(undefined, now)).toEqual({ runAt: new Date(now), priority: 0 });
    expect(messagePlacement({ delay: "5m" }, now)).toEqual({ runAt: new Date(now + 300_000), priority: 0 });
    expect(messagePlacement({ runAt: "2026-12-01T09:00:00Z", priority: 10 }, now)).toEqual({ runAt: new Date("2026-12-01T09:00:00Z"), priority: 10 });
    expect(messagePlacement({ runAt: new Date(now - 1000) }, now).runAt).toEqual(new Date(now - 1000));
    expect(failure(() => messagePlacement({ delay: "1m", runAt: "2026-12-01T09:00:00Z" }, now)).message).toBe("Invalid queue options: give delay or runAt, not both");
    expect(failure(() => messagePlacement({ delay: "-1m" }, now)).message).toStartWith("Invalid queue options: delay must be a duration that is not negative");
    expect(failure(() => messagePlacement({ runAt: "tomorrow" }, now)).message).toStartWith("Invalid queue options: runAt must be a Date or an ISO 8601 date-time");
    expect(failure(() => messagePlacement({ runAt: new Date(Number.NaN) }, now)).message).toStartWith("Invalid queue options: runAt must be");
    expect(failure(() => messagePlacement({ priority: 101 }, now)).message).toBe("Invalid queue options: priority must be an integer from -100 to 100");
    expect(failure(() => messagePlacement({ priority: 1.5 }, now)).message).toBe("Invalid queue options: priority must be an integer from -100 to 100");
  });

  test("a delayed message is not processed before its time and is after it; a past runAt runs at once", async () => {
    const adapter = await memory();
    const ran: string[] = [];
    const { store, clock } = setUp(adapter, { later: queue<{ name: string }>(({ payload }) => void ran.push(payload.name)) });
    await store.enqueue("later", { name: "delayed" }, {}, messagePlacement({ delay: "5m" }, clock.now()));
    await store.enqueue("later", { name: "past" }, {}, messagePlacement({ runAt: new Date(clock.now() - 60_000) }, clock.now()));
    store.start({} as never);
    await clock.advance(4 * 60_000);
    expect(ran).toEqual(["past"]);
    await clock.advance(60_000 + 1000);
    expect(ran).toEqual(["past", "delayed"]);
    store.stop();
  });
});

describe("claim order", () => {
  test("higher priorities run first, equal priorities in runAt order", async () => {
    const adapter = await memory();
    const ran: string[] = [];
    const { store, clock } = setUp(adapter, { ordered: queue<{ name: string }>(({ payload }) => void ran.push(payload.name)) });
    const add = (name: string, priority: number, offset = 0) => store.enqueue("ordered", { name }, {}, messagePlacement({ priority, runAt: new Date(clock.now() - 10_000 + offset) }, clock.now()));
    await add("zero", 0);
    await add("ten", 10);
    await add("minus-five", -5);
    await add("zero-later", 0, 2000);
    await add("zero-earlier", 0, 1000);
    store.start({} as never);
    await until(() => ran.length === 5, clock);
    expect(ran).toEqual(["ten", "zero", "zero-earlier", "zero-later", "minus-five"]);
    store.stop();
  });
});

describe("timeouts", () => {
  test("a handler running past its timeout sees its signal aborted, the message records the timeout, and a late result changes nothing", async () => {
    const adapter = await memory();
    const clockRef: { clock?: FakeClock } = {};
    let reason: unknown;
    const { store, clock } = setUp(
      adapter,
      {
        slow: queue(async ({ signal }) => {
          signal.addEventListener("abort", () => (reason = signal.reason));
          await clockRef.clock!.sleep(3000);
          return "late";
        }),
      },
      { timeout: "1s", retries: 0 },
    );
    clockRef.clock = clock;
    await store.enqueue("slow", {}, {});
    store.start({} as never);
    await clock.advance(999);
    expect(reason).toBeUndefined();
    await clock.advance(1);
    expect((reason as Error).name).toBe("TimeoutError");
    expect((reason as Error).message).toBe("Timed out after 1s");
    const [message] = await all(adapter);
    expect(message).toMatchObject({ status: "dead", lastError: { message: "Timed out after 1s" } });
    await clock.advance(3000);
    expect(await all(adapter)).toEqual([message!]);
    store.stop();
  });
});

describe("retries", () => {
  test("a handler failing twice then succeeding runs at 0s, 10s and 30s and ends completed", async () => {
    const adapter = await memory();
    const clockRef: { clock?: FakeClock } = {};
    const attempts: [number, number][] = [];
    const start = { at: 0 };
    const { store, clock } = setUp(
      adapter,
      {
        flaky: queue(({ message }) => {
          attempts.push([message.attempt, clockRef.clock!.now() - start.at]);
          if (message.attempt < 3) throw new Error(`attempt ${message.attempt} failed`);
          return "done";
        }),
      },
      { retryDelay: "10s", random: () => 0.5 },
    );
    clockRef.clock = clock;
    start.at = clock.now();
    await store.enqueue("flaky", {}, {});
    store.start({} as never);
    await clock.flush();
    expect((await all(adapter))[0]).toMatchObject({ status: "waiting", attempt: 1, lastError: { message: "attempt 1 failed" }, worker: null, lockedUntil: null });
    await clock.advance(31_000);
    // Polled every second: each retry starts within the poll after its runAt.
    expect(attempts.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(attempts.map(([, at]) => Math.floor(at / 1000))).toEqual([0, 10, 30]);
    expect((await all(adapter))[0]).toMatchObject({ status: "completed", attempt: 3, result: "done" });
    store.stop();
  });

  test("retry delays double up to maxRetryDelay, and the jitter stays within 10%", async () => {
    const delays = async (random: number) => {
      const adapter = await memory();
      const { store, clock } = setUp(adapter, { failing: queue(() => Promise.reject(new Error("no"))) }, { retryDelay: "1h", maxRetryDelay: "1h", retries: 3, random: () => random, pollInterval: "10m" });
      await store.enqueue("failing", {}, {});
      store.start({} as never);
      const found: number[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        await until(async () => (await all(adapter))[0]!.attempt === attempt && (await all(adapter))[0]!.status === "waiting", clock);
        const message = (await all(adapter))[0]!;
        // The delay counts from the failure, when the message was last updated.
        found.push(message.runAt.getTime() - message.updatedAt.getTime());
        await clock.advance(message.runAt.getTime() - clock.now() + 600_000);
      }
      store.stop();
      return found;
    };
    const hour = 3_600_000;
    expect(await delays(0.5)).toEqual([hour, hour, hour]);
    for (const delay of await delays(0)) expect(delay).toBe(3_240_000);
    for (const delay of await delays(1)) expect(delay).toBe(3_960_000);
  });

  test("a message failing every time ends dead after its last attempt, and a reclaimed last attempt ends dead", async () => {
    const adapter = await memory();
    const ran: number[] = [];
    const { store, clock } = setUp(
      adapter,
      {
        broken: queue(({ message }) => {
          ran.push(message.attempt);
          throw new Error("broken");
        }),
      },
      { retries: 1, retryDelay: "1s", random: () => 0.5 },
    );
    await store.enqueue("broken", {}, {});
    store.start({} as never);
    await clock.advance(10_000);
    expect(ran).toEqual([1, 2]);
    expect((await all(adapter))[0]).toMatchObject({ status: "dead", attempt: 2, maxAttempts: 2, lastError: { message: "broken" } });
    expect((await all(adapter))[0]!.finishedAt).toBeInstanceOf(Date);
    store.stop();

    const stale = await memory();
    const now = clock.now();
    await stale.insert(model, { id: Bun.randomUUIDv7(), createdAt: new Date(now), updatedAt: new Date(now), queue: "broken", payload: {}, status: "active", priority: 0, runAt: new Date(now - 60_000), attempt: 2, maxAttempts: 2, enqueuedAt: new Date(now - 60_000), worker: "gone:9", lockedUntil: new Date(now + 1000) });
    const next = setUp(stale, { broken: queue(() => {}) }, { clock });
    next.store.start({} as never);
    await clock.advance(RECLAIM_INTERVAL);
    expect((await all(stale))[0]).toMatchObject({ status: "dead", lastError: { message: "Lease expired after 5m" } });
    next.store.stop();
  });
});
