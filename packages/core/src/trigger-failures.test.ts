import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { fakeClock } from "./jobs/test-support.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { dispatchPlatformEvent, retryDelayMs, setTriggersClock, testDelivery, testSource, trigger, TriggerDiscard, type ErrorReport, type TriggerEvent, type TriggerPollContext, type TriggerSource } from "./index.ts";
import { emitTrigger } from "./testing/index.ts";

const started: TestApp[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  registerProjectFeatures([]);
  setTriggersClock();
});

const event = (id: string, extra: Partial<TriggerEvent> = {}): TriggerEvent => ({ id, kind: "stream", type: "record", time: new Date(0), data: { id, card: "4111-secret" }, attributes: { partition: "shard-1" }, attempt: 1, ...extra });
const sourceFeature = (source: TriggerSource) => ({
  folder: "streams",
  definition: defineFeature({ key: "streams", enabledByDefault: true, requires: ["triggers"], setup: (ctx) => ctx.feature("triggers").source(source.kind, source as never) }),
});
const start = async (triggers: Record<string, unknown>, config: Record<string, unknown> = {}, source?: TriggerSource) => {
  if (source) registerProjectFeatures([sourceFeature(source)]);
  const app = await startTestApp({ config: { triggers: {}, ...config }, featureFolders: { triggers: { triggers: new Map(Object.entries(triggers)) } } });
  started.push(app);
  return app;
};

describe("classification", () => {
  test("TriggerDiscard ends discarded with its reason and is logged; a plain error ends failed", async () => {
    const app = await start({
      images: trigger({ source: testSource(), handle: () => Promise.reject(new TriggerDiscard("not an image")) }),
      broken: trigger({ source: testSource(), handle: () => Promise.reject(new Error("boom")) }),
    });
    expect(await emitTrigger("images" as never, {} as never)).toMatchObject({ status: "discarded", reason: "not an image" });
    expect(await emitTrigger("broken" as never, {} as never)).toMatchObject({ status: "failed", error: new Error("boom") });
    expect(app.logs.find((entry) => entry.message === "trigger.event.discarded")).toMatchObject({ level: "info", trigger: "images", reason: "not an image" });
  });
});

describe("function mode", () => {
  test("of three unordered events with the middle one failing, the result lists only the middle event, and attempts come from the delivery", async () => {
    const attempts: number[] = [];
    await start({
      orders: trigger({
        source: testSource(),
        handle: ({ event, attempt }) => {
          attempts.push(attempt);
          if (event.id === "e2") throw new Error("boom");
        },
      }),
    });
    const dispatched = await dispatchPlatformEvent("lambda", testDelivery([{ id: "e1" }, { id: "e2", attempt: 3 }, { id: "e3" }]));
    expect(dispatched!.response).toEqual({ batchItemFailures: [{ itemIdentifier: "e2" }] });
    expect(attempts).toEqual([1, 3, 1]);
  });
});

describe("ordered batches", () => {
  test("in an ordered batch of five events of one partition where the second fails, two to five are failed and three to five never run", async () => {
    const ran: string[] = [];
    const ordered: TriggerSource = {
      kind: "stream",
      ordered: true,
      recognize: (_platform, raw) => Array.isArray((raw as { records?: unknown })?.records),
      decode: (raw) => (raw as { records: string[] }).records.map((id) => event(id)),
      matches: () => true,
      result: (outcomes) => ({ failed: outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.eventId) }),
    };
    await start(
      {
        records: trigger({
          source: { kind: "stream" },
          handle: ({ event }) => {
            ran.push(event.id);
            if (event.id === "r2") throw new Error("boom");
          },
        }),
      },
      {},
      ordered,
    );
    const dispatched = await dispatchPlatformEvent("lambda", { records: ["r1", "r2", "r3", "r4", "r5"] });
    expect(ran).toEqual(["r1", "r2"]);
    expect(dispatched!.response).toEqual({ failed: ["r2", "r3", "r4", "r5"] });
    expect((dispatched!.outcomes[2]!.error as Error).message).toBe("Not handled: the earlier event r2 of its partition failed");
  });
});

describe("polling retries", () => {
  test("with retries 2 a failing event is retried after 10 and 20 seconds, then dead-lettered and logged trigger.event.dead", async () => {
    const clock = fakeClock();
    setTriggersClock(clock, () => 0.5);
    const deliveries: number[] = [];
    const dead: string[] = [];
    let begin = 0;
    const polling: TriggerSource = {
      kind: "stream",
      recognize: () => false,
      decode: () => [],
      matches: () => true,
      async poll(_ref, ctx: TriggerPollContext) {
        begin = clock.now();
        const deliver = async (attempt: number) => {
          deliveries.push(clock.now() - begin);
          await ctx.emit([event("m1", { attempt })], { nack: (_outcome, { retryInMs }) => void clock.setTimeout(() => void deliver(attempt + 1), retryInMs), deadLetter: (outcome) => void dead.push(outcome.eventId) });
        };
        await deliver(1);
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      },
    };
    const app = await start({ records: trigger({ source: { kind: "stream" }, options: { retries: 2 }, handle: () => Promise.reject(new Error("boom")) }) }, {}, polling);
    await clock.advance(10_000);
    await clock.advance(20_000);
    expect(deliveries).toEqual([0, 10_000, 30_000]);
    expect(dead).toEqual(["m1"]);
    expect(app.logs.filter((entry) => entry.message === "trigger.event.dead")).toEqual([expect.objectContaining({ level: "error", trigger: "records", eventId: "m1", attempt: 3, error: { message: "boom" } })]);
  });

  test("the retry delay doubles per attempt, caps at one hour and has ±10% jitter", () => {
    expect(retryDelayMs("10s", 1, () => 0.5)).toBe(10_000);
    expect(retryDelayMs("10s", 2, () => 0.5)).toBe(20_000);
    expect(retryDelayMs("10s", 20, () => 0.5)).toBe(3_600_000);
    expect(retryDelayMs("10s", 1, () => 0)).toBe(9000);
    expect(retryDelayMs("10s", 1, () => 1)).toBe(11_000);
  });
});

describe("reports and events", () => {
  test("a dead event calls reportError with the trigger, kind, eventId and attempt but no data, and emits trigger.event.dead; failures emit trigger.event.failed", async () => {
    const clock = fakeClock();
    setTriggersClock(clock, () => 0.5);
    const reports: ErrorReport[] = [];
    const announced: { type: string; payload: unknown }[] = [];
    const polling: TriggerSource = {
      kind: "stream",
      recognize: () => false,
      decode: () => [],
      matches: () => true,
      async poll(_ref, ctx: TriggerPollContext) {
        await ctx.emit([event("m1", { attempt: 1 })]);
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      },
    };
    const listening = {
      folder: "listener",
      definition: defineFeature({
        key: "listener",
        enabledByDefault: true,
        requires: ["events"],
        setup(ctx) {
          for (const type of ["trigger.event.failed", "trigger.event.dead"] as const) ctx.feature("events").on(type, (fired) => void announced.push({ type: fired.type, payload: fired.payload }));
        },
      }),
    };
    registerProjectFeatures([sourceFeature(polling), listening]);
    const app = await startTestApp({ config: { triggers: {}, events: {}, errors: { reporter: { report: (report: ErrorReport) => void reports.push(report) } } }, featureFolders: { triggers: { triggers: new Map(Object.entries({ records: trigger({ source: { kind: "stream" }, options: { retries: 0 }, handle: () => Promise.reject(new Error("boom")) }) })) } } });
    started.push(app);
    await clock.advance(10);
    const payload = { trigger: "records", kind: "stream", eventId: "m1", attempt: 1, error: { message: "boom" } };
    expect(announced).toEqual([
      { type: "trigger.event.failed", payload },
      { type: "trigger.event.dead", payload },
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "manual", error: { message: "boom" }, tags: { trigger: "records", kind: "stream", eventId: "m1", attempt: "1" } });
    expect(JSON.stringify(reports[0])).not.toContain("4111-secret");
  });
});
