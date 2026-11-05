import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { fakeClock } from "./jobs/test-support.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { checkpointStore, parseDuration, setTriggersClock, targetPolls, trigger, triggerCheckpointEntity, type TriggerEvent, type TriggerOutcome, type TriggerPollContext, type TriggerSource } from "./index.ts";

const started: TestApp[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  registerProjectFeatures([]);
  setTriggersClock();
});

const event = (id: string): TriggerEvent => ({ id, kind: "pull", type: "message", time: new Date(0), data: { id }, attributes: {}, attempt: 1 });

/** A polling source of kind `pull` whose poll is the given function. */
const pullSource = (poll: (ref: unknown, ctx: TriggerPollContext) => void | Promise<void>): TriggerSource => ({ kind: "pull", recognize: () => false, decode: () => [], matches: () => true, poll });
const sourceFeature = (source: TriggerSource) => ({
  folder: "puller",
  definition: defineFeature({ key: "puller", enabledByDefault: true, requires: ["triggers"], entities: [triggerCheckpointEntity], setup: (ctx) => ctx.feature("triggers").source(source.kind, source as never) }),
});

const start = async (source: TriggerSource, triggers: Record<string, unknown>, config: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
  registerProjectFeatures([sourceFeature(source)]);
  const app = await startTestApp({ config: { triggers: {}, ...config }, env, models: [triggerCheckpointEntity], featureFolders: { triggers: { triggers: new Map(Object.entries(triggers)) } } });
  started.push(app);
  return app;
};

/** A poll that emits the given events once, then waits for the shutdown. */
const emitOnce = (events: TriggerEvent[], seen: TriggerOutcome[][] = []) => async (_ref: unknown, ctx: TriggerPollContext) => {
  seen.push(await ctx.emit(events));
  await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
};

describe("where polls start", () => {
  test("a polling source emitting two events runs the trigger twice on a server, and never on lambda or with QS_TRIGGERS_POLL=false", async () => {
    const handled: string[] = [];
    const definition = () => ({ orders: trigger({ source: { kind: "pull" }, handle: ({ event }) => void handled.push(event.id) }) });
    const polled: string[] = [];
    const source = pullSource(async (ref, ctx) => {
      polled.push("poll");
      await emitOnce([event("a"), event("b")])(ref, ctx);
    });
    await start(source, definition());
    await Bun.sleep(20);
    expect(handled).toEqual(["a", "b"]);
    await started.pop()!.stop();
    await start(source, definition(), { deploy: { target: "lambda" } });
    await start(source, definition(), {}, { QS_TRIGGERS_POLL: "false" });
    await Bun.sleep(20);
    expect(polled).toEqual(["poll"]);
    expect(handled).toEqual(["a", "b"]);
  });

  test("the options default to poll true and a backoff of 1s to 30s, and the targets decide", () => {
    expect(targetPolls({ features: [] })).toBe(true);
    const deploy = (options: Record<string, unknown>) => ({ features: [{ key: "deploy", options }] }) as never;
    expect(targetPolls(deploy({ target: "server" }))).toBe(true);
    expect(targetPolls(deploy({ target: "binary" }))).toBe(true);
    expect(targetPolls(deploy({ target: "lambda" }))).toBe(false);
    expect(targetPolls(deploy({ target: "azure-functions" }))).toBe(false);
    expect(targetPolls(deploy({ target: "cloud-run", cloudRun: { cpuAlwaysAllocated: false } }))).toBe(false);
    expect(targetPolls(deploy({ target: "cloud-run", cloudRun: { cpuAlwaysAllocated: true } }))).toBe(true);
  });
});

describe("emission", () => {
  test("emit resolves once every event was handled and acknowledges each outcome", async () => {
    const acks: string[] = [];
    const nacks: string[] = [];
    const resolved: TriggerOutcome[][] = [];
    const source = pullSource(async (_ref, ctx) => {
      resolved.push(await ctx.emit([event("good"), event("bad")], { ack: (outcome) => void acks.push(outcome.eventId), nack: (outcome) => void nacks.push(outcome.eventId) }));
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
    });
    await start(source, { orders: trigger({ source: { kind: "pull" }, handle: ({ event }) => (event.id === "bad" ? Promise.reject(new Error("boom")) : Bun.sleep(5)) }) });
    await Bun.sleep(40);
    expect(resolved[0]!.map((outcome) => [outcome.eventId, outcome.status])).toEqual([["good", "completed"], ["bad", "failed"]]);
    expect(acks).toEqual(["good"]);
    expect(nacks).toEqual(["bad"]);
  });
});

describe("backoff", () => {
  test("a poll that throws twice restarts after 1 and 2 seconds, logging trigger.poll.failed, and the delay resets after an emission", async () => {
    const clock = fakeClock();
    setTriggersClock(clock);
    const calls: number[] = [];
    let attempt = 0;
    const source = pullSource(async (_ref, ctx) => {
      attempt++;
      calls.push(clock.now());
      if (attempt <= 2 || attempt === 4) throw new Error(`down ${attempt}`);
      await ctx.emit([event(`e${attempt}`)]);
      throw new Error("after emission");
    });
    const app = await start(source, { orders: trigger({ source: { kind: "pull" }, handle() {} }) });
    const begin = calls[0]!;
    await clock.advance(1000);
    await clock.advance(2000);
    // The third run emitted, then threw: the next delay is 1s again, then 2s after the fourth failure.
    await clock.advance(1000);
    await clock.advance(2000);
    expect(calls.map((at) => at - begin)).toEqual([0, 1000, 3000, 4000, 6000]);
    const failures = app.logs.filter((entry) => entry.message === "trigger.poll.failed");
    expect(failures.slice(0, 2)).toEqual([expect.objectContaining({ level: "error", trigger: "orders", error: { message: "down 1" } }), expect.objectContaining({ trigger: "orders", error: { message: "down 2" } })]);
    await app.stop();
    expect(clock.timers()).toBe(0);
  });
});

describe("checkpoints", () => {
  const stores = async () => {
    const adapter = memoryAdapter();
    await adapter.connect([triggerCheckpointEntity]);
    let now = 1_000_000;
    const make = (owner: string) => checkpointStore({ adapter, trigger: "orders", owner, now: () => now, parse: parseDuration });
    return { adapter, a: make("worker-a"), b: make("worker-b"), advance: (ms: number) => (now += ms) };
  };

  test("two workers get disjoint leases; once the leases of one that stopped expire, the other claims its partitions and resumes from the saved positions", async () => {
    const { a, b, advance } = await stores();
    expect(await a.claim(["p1", "p2"], { ttl: "30s" })).toEqual([{ partition: "p1", position: null }, { partition: "p2", position: null }]);
    expect((await b.claim(["p1", "p2", "p3", "p4"], { ttl: "30s" })).map((claimed) => claimed.partition)).toEqual(["p3", "p4"]);
    expect(await a.save("p1", "seq-10")).toBe(true);
    expect(await a.save("p2", "seq-20")).toBe(true);
    // Worker a stops without releasing; b claims nothing until its leases expire.
    advance(10_000);
    expect(await b.claim(["p1", "p2"], { ttl: "30s" })).toEqual([]);
    advance(21_000);
    expect(await b.claim(["p1", "p2"], { ttl: "30s" })).toEqual([{ partition: "p1", position: "seq-10" }, { partition: "p2", position: "seq-20" }]);
    expect(b.held()).toEqual(["p3", "p4", "p1", "p2"]);
    expect(await b.renew()).toEqual(["p3", "p4", "p1", "p2"]);
  });

  test("a save by a worker that lost the lease does not change the position, and a released partition is claimed at once", async () => {
    const { adapter, a, b, advance } = await stores();
    await a.claim(["p1"], { ttl: "1s" });
    await a.save("p1", "seq-1");
    advance(2000);
    await b.claim(["p1"], { ttl: "30s" });
    expect(await a.save("p1", "seq-99")).toBe(false);
    expect((await adapter.findOne(triggerCheckpointEntity, [{ field: "partition", op: "eq", value: "p1" }]))!.position).toBe("seq-1");
    await b.release("p1");
    expect(await a.claim(["p1"], { ttl: "30s" })).toEqual([{ partition: "p1", position: "seq-1" }]);
  });
});

describe("shutdown", () => {
  test("on shutdown the poll signal aborts, running handlers finish, leases are released and no timer remains", async () => {
    const clock = fakeClock();
    setTriggersClock(clock);
    let signal: AbortSignal | undefined;
    let finished = false;
    let release: () => void = () => {};
    const source = pullSource(async (_ref, ctx) => {
      signal = ctx.signal;
      await ctx.checkpoints.claim(["p1"], { ttl: "30s" });
      await ctx.emit([event("slow")]);
    });
    const app = await start(source, {
      orders: trigger({ source: { kind: "pull" }, handle: () => new Promise<void>((resolve) => (release = () => ((finished = true), resolve()))) }),
    });
    await Bun.sleep(10);
    const stopping = app.stop();
    await Bun.sleep(10);
    expect(signal!.aborted).toBe(true);
    expect(finished).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    const lease = await app.database.findOne(triggerCheckpointEntity, [{ field: "partition", op: "eq", value: "p1" }]);
    expect(lease?.owner ?? null).toBeNull();
    expect(clock.timers()).toBe(0);
  });
});
