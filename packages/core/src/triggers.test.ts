import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { currentOperation, enableOperationContext, disableOperationContext } from "./operation-context.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { isTriggerDefinition, testDelivery, testSource, testTriggerSource, trigger, triggersFeature, type TriggerContext, type TriggerSource } from "./index.ts";
import { emitTrigger } from "./testing/index.ts";

const started: TestApp[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  registerProjectFeatures([]);
  disableOperationContext();
});

const start = async (triggers: Record<string, unknown>, config: Record<string, unknown> = {}) => {
  const app = await startTestApp({ config: { triggers: {}, ...config }, featureFolders: { triggers: { triggers: new Map(Object.entries(triggers)) } } });
  started.push(app);
  return app;
};

/** A source of kind `fake` whose events match a reference by `name`. */
const fakeSource = (): TriggerSource<{ kind: string; name?: string }> => ({
  kind: "fake",
  recognize: (_platform, raw) => (raw as { fake?: boolean })?.fake === true,
  decode: () => [],
  matches: (ref, event) => ref.name === undefined || event.subject === ref.name,
});
const project = (definition: ReturnType<typeof defineFeature>) => ({ folder: definition.key, definition });
const sourceFeature = (key: string) =>
  defineFeature({
    key,
    enabledByDefault: true,
    requires: ["triggers"],
    setup(ctx) {
      ctx.feature("triggers").source("fake", fakeSource() as never);
    },
  });

describe("trigger definitions", () => {
  test("trigger() applies the option defaults, keeps batch and the source, and rejects a missing source or handler", () => {
    const handle = () => {};
    const definition = trigger({ source: testSource(), handle });
    expect(isTriggerDefinition(definition)).toBe(true);
    expect(definition).toMatchObject({ source: { kind: "test" }, handle, batch: false, options: { concurrency: 1, timeout: "30s", retries: 3, retryDelay: "10s" } });
    expect(trigger({ source: testSource({ type: "upload" }), handle, batch: true, options: { concurrency: 4, retries: 0 } })).toMatchObject({ batch: true, source: { kind: "test", type: "upload" }, options: { concurrency: 4, timeout: "30s", retries: 0, retryDelay: "10s" } });
    expect(isTriggerDefinition({ source: testSource(), handle })).toBe(false);
    expect(() => trigger({ source: {} as never, handle })).toThrow("trigger() needs a source reference");
    expect(() => trigger({ source: testSource(), handle: undefined as never })).toThrow("trigger() needs a handle function");
    expect(() => trigger({ source: testSource(), handle, options: { concurrency: 0 } })).toThrow("options.concurrency");
  });

  test("the native is off by default and has a triggers folder named by path with the feature prefix", () => {
    expect(triggersFeature.enabledByDefault).toBe(false);
    expect(triggersFeature.folders?.triggers).toMatchObject({ dir: "triggers", featurePrefix: true });
    expect(triggersFeature.folders!.triggers!.check!(() => {}, "triggers/a.ts")).toBe("must default-export trigger(...)");
    expect(triggersFeature.folders!.triggers!.check!(trigger({ source: testSource(), handle() {} }), "triggers/a.ts")).toBe(true);
  });
});

describe("sources", () => {
  test("a feature registering kind fake starts a trigger on fake; a trigger on nope fails startup; two owners of fake fail naming both", async () => {
    registerProjectFeatures([project(sourceFeature("fakes"))]);
    await start({ sync: trigger({ source: { kind: "fake" }, handle() {} }) });
    await started.pop()!.stop();
    await expect(start({ broken: trigger({ source: { kind: "nope" }, handle() {} }) })).rejects.toThrow("triggers/broken uses source nope, which no feature registers; enable the feature that provides it");
    registerProjectFeatures([project(sourceFeature("fakes")), project(sourceFeature("others"))]);
    await expect(start({})).rejects.toThrow("Trigger source fake is registered by fakes and others; keep one");
  });

  test("an invalid source and a registration outside another feature's setup fail", async () => {
    registerProjectFeatures([project(defineFeature({ key: "bad", enabledByDefault: true, requires: ["triggers"], setup: (ctx) => ctx.feature("triggers").source("bad", { kind: "bad" } as never) }))]);
    await expect(start({})).rejects.toThrow("Invalid trigger source bad registered by bad: the TriggerSource is missing recognize, decode, matches");
  });
});

describe("the handler context", () => {
  test("handle gets the event, the trigger name, repos, http, files and a log with trigger and eventId, inside the job operation trigger/<name>", async () => {
    enableOperationContext();
    const seen: { context?: TriggerContext<{ key: string }>; operation?: unknown } = {};
    const app = await start({
      "uploads/new-image": trigger<{ key: string }>({
        source: testSource(),
        handle(context) {
          seen.context = context;
          seen.operation = currentOperation();
          context.log.info("handled", { key: context.event.data.key });
        },
      }),
    });
    const outcome = await emitTrigger("uploads/new-image" as never, { key: "a.png" } as never, { attributes: { bucket: "photos" } });
    const { context } = seen;
    expect(outcome).toMatchObject({ status: "completed", outcomes: [{ eventId: outcome.eventId, trigger: "uploads/new-image", status: "completed" }] });
    expect(context!.event).toMatchObject({ id: outcome.eventId, kind: "test", data: { key: "a.png" }, attributes: { bucket: "photos" }, attempt: 1 });
    expect(context!.trigger).toBe("uploads/new-image");
    expect(context!.attempt).toBe(1);
    expect(context!.repos).toBeDefined();
    expect(typeof context!.http.get).toBe("function");
    expect(typeof context!.files.createFile).toBe("function");
    expect(context!.signal.aborted).toBe(false);
    expect(context!.queue).toBeUndefined();
    expect(seen.operation).toEqual({ job: { name: "trigger/uploads/new-image", runId: outcome.eventId } });
    expect(app.logs.find((entry) => entry.message === "handled")).toMatchObject({ key: "a.png", trigger: "uploads/new-image", eventId: outcome.eventId });
  });

  test("a failing handler resolves failed with its error; a handler past its timeout fails with the signal aborted", async () => {
    let signal: AbortSignal | undefined;
    await start({
      broken: trigger({ source: testSource(), handle: () => Promise.reject(new Error("boom")) }),
      slow: trigger({ source: testSource(), options: { timeout: "50ms" }, handle: (context) => ((signal = context.signal), new Promise(() => {})) }),
    });
    const broken = await emitTrigger("broken" as never, {} as never);
    expect(broken).toMatchObject({ status: "failed", error: new Error("boom") });
    const slow = await emitTrigger("slow" as never, {} as never);
    expect(slow.status).toBe("failed");
    expect((slow.error as Error).message).toBe("Trigger slow timed out after 50 ms");
    expect(signal!.aborted).toBe(true);
  });
});

describe("the test source and emitTrigger", () => {
  test("a batch trigger receives ctx.events with every event of one emission", async () => {
    const batches: unknown[][] = [];
    await start({ batch: trigger({ source: testSource(), batch: true, handle: ({ events }) => void batches.push(events!.map((event) => event.data)) }) });
    const outcome = await emitTrigger("batch" as never, [{ n: 1 }, { n: 2 }, { n: 3 }] as never);
    expect(batches).toEqual([[{ n: 1 }, { n: 2 }, { n: 3 }]]);
    expect(outcome.outcomes.map((entry) => entry.status)).toEqual(["completed", "completed", "completed"]);
  });

  test("test deliveries are recognized and decoded with stable ids, matched by type, and answered with the failed events", async () => {
    const raw = testDelivery([{ id: "e1", type: "upload", data: { key: "a" } }, { data: { key: "b" } }]);
    expect(testTriggerSource.recognize("lambda", raw)).toBe(true);
    expect(testTriggerSource.recognize("lambda", { Records: [] })).toBe(false);
    const events = await testTriggerSource.decode(raw);
    expect(events).toMatchObject([{ id: "e1", kind: "test", type: "upload", data: { key: "a" }, attempt: 1 }, { kind: "test", type: "test", data: { key: "b" } }]);
    expect((await testTriggerSource.decode(raw))[1]!.id).toBe(events[1]!.id);
    expect(testTriggerSource.matches(testSource({ type: "upload" }), events[0]!)).toBe(true);
    expect(testTriggerSource.matches(testSource({ type: "upload" }), events[1]!)).toBe(false);
    expect(testTriggerSource.matches(testSource(), events[1]!)).toBe(true);
    expect(testTriggerSource.result!([{ eventId: "e1", trigger: "t", status: "failed" }, { eventId: "e2", trigger: "t", status: "completed" }], raw)).toEqual({ batchItemFailures: [{ itemIdentifier: "e1" }] });
  });

  test("emitTrigger rejects an unknown trigger and while the native does not run; without trigger files nothing is added", async () => {
    await expect(emitTrigger("nope" as never, {} as never)).rejects.toThrow("triggers is not enabled; add triggers: {} to quickservicets.config.ts");
    const app = await start({});
    await expect(emitTrigger("nope" as never, {} as never)).rejects.toThrow("Unknown trigger nope");
    expect(app.lifecycle.routes).toEqual([]);
  });
});
