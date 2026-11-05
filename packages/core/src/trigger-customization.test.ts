import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { cloudEvents, cloudEventsSource, dispatchPlatformEvent, effectiveTriggerOptions, testDelivery, testSource, testTriggerSource, trigger, triggersFeature, type TriggerFailed, type TriggerSource } from "./index.ts";
import { checkTriggerSource, emitTrigger, runTriggerSourceContract } from "./testing/index.ts";

const started: TestApp[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  registerProjectFeatures([]);
});

const start = async (triggers: Record<string, unknown>, config: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
  const app = await startTestApp({ config: { triggers: {}, ...config }, env, featureFolders: { triggers: { triggers: new Map(Object.entries(triggers)) } } });
  started.push(app);
  return app;
};

/** A trigger whose handler records how many of its events run at once. */
const gated = (options: { concurrency?: number } = {}) => {
  const state = { running: 0, peak: 0 };
  const definition = trigger({
    source: testSource(),
    options,
    handle: async () => {
      state.peak = Math.max(state.peak, ++state.running);
      await Bun.sleep(15);
      state.running--;
    },
  });
  return { state, definition };
};
const tenEvents = () => testDelivery(Array.from({ length: 10 }, (_, index) => ({ id: `e${index}` })));

describe("variables and overrides", () => {
  test("the per-trigger variable wins over overrides, which win over the file, and none of them is an unknown variable", async () => {
    const peak = async (config: Record<string, unknown>, env: Record<string, string> = {}) => {
      const { state, definition } = gated({ concurrency: 2 });
      const app = await start({ "uploads/new-image": definition }, config, env);
      await dispatchPlatformEvent("lambda", tenEvents());
      await app.stop();
      started.splice(started.indexOf(app), 1);
      return { peak: state.peak, warnings: app.config.warnings };
    };
    const env = { QS_TRIGGERS_OVERRIDES_UPLOADS_NEW_IMAGE_CONCURRENCY: "4" };
    const withEnv = await peak({ triggers: { overrides: { "uploads/new-image": { concurrency: 3 } } } }, env);
    expect(withEnv.peak).toBe(4);
    expect(withEnv.warnings.filter((warning) => warning.startsWith("Unknown environment variable"))).toEqual([]);
    expect((await peak({ triggers: { overrides: { "uploads/new-image": { concurrency: 3 } } } })).peak).toBe(3);
    expect((await peak({})).peak).toBe(2);
    expect(() => effectiveTriggerOptions("a", { concurrency: 1, timeout: "30s", retries: 3, retryDelay: "10s" }, {}, { QS_TRIGGERS_OVERRIDES_A_CONCURRENCY: "zero" })).toThrow("Invalid QS_TRIGGERS_OVERRIDES_A_CONCURRENCY: expected an integer of at least 1");
    expect(effectiveTriggerOptions("a/b-c", { concurrency: 1, timeout: "30s", retries: 3, retryDelay: "10s" }, { retries: 1 }, { QS_TRIGGERS_OVERRIDES_A_B_C_TIMEOUT: "5s", QS_TRIGGERS_OVERRIDES_A_B_C_RETRY_DELAY: "1s" })).toEqual({ concurrency: 1, timeout: "5s", retries: 1, retryDelay: "1s", enabled: true });
  });

  test("enabled false skips one trigger, and an override naming no trigger adds a warning", async () => {
    const app = await start({ "uploads/new-image": trigger({ source: testSource(), handle() {} }) }, { triggers: { overrides: { "uploads/new-image": { enabled: false }, nope: { concurrency: 2 } } } });
    await expect(emitTrigger("uploads/new-image" as never, {} as never)).rejects.toThrow("Unknown trigger uploads/new-image");
    expect(app.config.warnings).toContain("triggers.overrides.nope matches no trigger");
  });

  test("level 0 needs no options, which default to no overrides, hooks or sources, and the per-trigger variables are known", async () => {
    const app = await start({ pushed: trigger({ source: cloudEvents(), handle() {} }) });
    expect(app.config.features.find((feature) => feature.key === "triggers")!.options).toMatchObject({ enabled: true, overrides: {}, beforeHandle: [], afterHandle: [], onFailed: [], sources: [], poll: true, pollBackoff: { min: "1s", max: "30s" } });
    expect(triggersFeature.variablePatterns?.[0]!.test("QS_TRIGGERS_OVERRIDES_UPLOADS_NEW_IMAGE_CONCURRENCY")).toBe(true);
  });
});

describe("the when filter and hooks", () => {
  test("when discards a .txt key with the reason when", async () => {
    let handled = 0;
    await start({ images: trigger<{ key: string }>({ source: testSource(), options: { when: (event) => (event.data as { key: string }).key.endsWith(".png") }, handle: () => void handled++ }) });
    expect(await emitTrigger("images" as never, { key: "a.txt" } as never)).toMatchObject({ status: "discarded", reason: "when" });
    expect(await emitTrigger("images" as never, { key: "a.png" } as never)).toMatchObject({ status: "completed" });
    expect(handled).toBe(1);
  });

  test("beforeHandle returning null discards and a changed event reaches the handler; afterHandle sees each outcome; onFailed gets final on the last attempt", async () => {
    const seen: unknown[] = [];
    const after: string[] = [];
    const failures: Pick<TriggerFailed, "final">[] = [];
    const extra = {
      folder: "audit",
      definition: defineFeature({ key: "audit", enabledByDefault: true, requires: ["triggers"], setup: (ctx) => ctx.feature("triggers").addHook("afterHandle", ({ status }) => void after.push(`feature:${status}`)) }),
    };
    registerProjectFeatures([extra]);
    await start(
      {
        orders: trigger({ source: testSource(), handle: ({ event }) => (seen.push(event.data), (event.data as { fail?: boolean }).fail ? Promise.reject(new Error("boom")) : undefined) }),
      },
      {
        triggers: {
          beforeHandle: ({ event }: { event: { data: { skip?: boolean } } }) => (event.data.skip ? null : { ...event, data: { ...event.data, stamped: true } }),
          afterHandle: ({ status }: { status: string }) => void after.push(status),
          onFailed: ({ final }: TriggerFailed) => void failures.push({ final }),
        },
      },
    );
    await dispatchPlatformEvent("lambda", testDelivery([{ id: "a", data: { skip: true } }, { id: "b", data: {} }, { id: "c", data: { fail: true }, attempt: 1 }, { id: "d", data: { fail: true }, attempt: 4 }]));
    expect(seen).toEqual([{ stamped: true }, { fail: true, stamped: true }, { fail: true, stamped: true }]);
    expect(after).toEqual(["discarded", "feature:discarded", "completed", "feature:completed", "failed", "feature:failed", "failed", "feature:failed"]);
    expect(failures).toEqual([{ final: false }, { final: true }]);
  });
});

describe("project sources and the contract", () => {
  /** A source of kind `fake` whose deliveries are `{ fake: [ids] }`, with ids made by `idOf`. */
  const fakeSource = (idOf: (id: string) => string = (id) => id): TriggerSource => ({
    kind: "fake",
    recognize: (_platform, raw) => Array.isArray((raw as { fake?: unknown })?.fake),
    decode: (raw) => (raw as { fake: string[] }).fake.map((id) => ({ id: idOf(id), kind: "fake", type: "fake.event", time: new Date(0), data: { id }, attributes: {}, attempt: 1 })),
    matches: () => true,
  });

  test("a source in sources runs a trigger, and a kind it shares with a built-in fails naming both", async () => {
    const handled: string[] = [];
    await start({ fakes: trigger({ source: { kind: "fake" }, handle: ({ event }) => void handled.push(event.id) }) }, { triggers: { sources: [fakeSource()] } });
    await dispatchPlatformEvent("lambda", { fake: ["x", "y"] });
    expect(handled).toEqual(["x", "y"]);
    await expect(start({}, { triggers: { sources: [{ ...fakeSource(), kind: "test" }] } })).rejects.toThrow("Trigger source test is registered by triggers and triggers.sources; keep one");
  });

  test("a source whose ids change between redeliveries fails the contract", async () => {
    const failures = await checkTriggerSource(() => fakeSource((id) => `${id}-${crypto.randomUUID()}`) as never, { fixtures: { raw: { fake: ["a", "b"] }, ref: { kind: "fake" } } });
    expect(failures.map((failure) => failure.check)).toEqual(["keeps event ids stable across redeliveries"]);
    expect(await checkTriggerSource(() => fakeSource() as never, { fixtures: { raw: { fake: ["a"] }, ref: { kind: "fake" } } })).toEqual([]);
  });
});

runTriggerSourceContract(() => testTriggerSource as never, { name: "test source", fixtures: { raw: testDelivery([{ id: "a", type: "upload" }, { id: "b", type: "upload" }]), ref: testSource({ type: "upload" }), otherRef: testSource({ type: "other" }) } });
runTriggerSourceContract(() => cloudEventsSource as never, {
  name: "cloudevents source",
  fixtures: {
    raw: [
      { specversion: "1.0", id: "c1", type: "storage.object.created", source: "/bucket", data: { key: "a" } },
      { specversion: "1.0", id: "c2", type: "storage.object.created", source: "/bucket", data: { key: "b" } },
    ],
    ref: cloudEvents({ type: "storage.*" }),
    otherRef: cloudEvents({ type: "billing.*" }),
  },
});
