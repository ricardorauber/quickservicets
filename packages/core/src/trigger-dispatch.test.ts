import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { dispatchPlatformEvent, testDelivery, testSource, trigger, type TriggerEvent, type TriggerOutcome, type TriggerSource } from "./index.ts";

const started: TestApp[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  registerProjectFeatures([]);
});

/** A bucket source: a raw `{ bucket, keys }` event is one event per key, and a reference matches its bucket and prefix. */
type BucketRef = { kind: "bucket"; bucket: string; prefix?: string };
const bucketSource = (extra: Partial<TriggerSource<BucketRef>> = {}): TriggerSource<BucketRef> => ({
  kind: "bucket",
  recognize: (_platform, raw) => typeof (raw as { bucket?: unknown })?.bucket === "string",
  decode: (raw) => {
    const { bucket, keys } = raw as { bucket: string; keys: string[] };
    return keys.map((key): TriggerEvent => ({ id: `${bucket}/${key}`, kind: "bucket", type: "object.created", time: new Date(0), subject: key, data: { key }, attributes: { bucket }, attempt: 1 }));
  },
  matches: (ref, event) => event.attributes.bucket === ref.bucket && (ref.prefix === undefined || event.subject!.startsWith(ref.prefix)),
  ...extra,
});
const sourceFeature = (source: TriggerSource<never>, key = "buckets") => ({
  folder: key,
  definition: defineFeature({ key, enabledByDefault: true, requires: ["triggers"], setup: (ctx) => ctx.feature("triggers").source(source.kind, source) }),
});

const start = async (triggers: Record<string, unknown>) => {
  const app = await startTestApp({ config: { triggers: {} }, featureFolders: { triggers: { triggers: new Map(Object.entries(triggers)) } } });
  started.push(app);
  return app;
};

describe("recognition", () => {
  test("sources are asked in registration order, the first that recognizes decodes, and an event none recognizes resolves undefined", async () => {
    const greedy: TriggerSource = { kind: "greedy", recognize: () => true, decode: () => [], matches: () => true };
    registerProjectFeatures([sourceFeature(greedy as never, "greedy")]);
    const seen: string[] = [];
    await start({ tests: trigger({ source: testSource(), handle: ({ event }) => void seen.push(event.id) }) });
    expect((await dispatchPlatformEvent("lambda", testDelivery([{ id: "e1" }])))?.kind).toBe("test");
    expect(seen).toEqual(["e1"]);
    expect((await dispatchPlatformEvent("lambda", { anything: true }))?.kind).toBe("greedy");
    registerProjectFeatures([]);
    await started.pop()!.stop();
    await start({});
    expect(await dispatchPlatformEvent("lambda", { anything: true })).toBeUndefined();
  });
});

describe("matching", () => {
  test("each trigger receives only the keys of its prefix, and an event no trigger takes is logged unmatched and completed", async () => {
    registerProjectFeatures([sourceFeature(bucketSource() as never)]);
    const received: Record<string, string[]> = { images: [], docs: [] };
    const app = await start({
      images: trigger({ source: { kind: "bucket", bucket: "files", prefix: "images/" }, handle: ({ event }) => void received.images!.push(event.subject!) }),
      docs: trigger({ source: { kind: "bucket", bucket: "files", prefix: "docs/" }, handle: ({ event }) => void received.docs!.push(event.subject!) }),
    });
    const dispatched = await dispatchPlatformEvent("lambda", { bucket: "files", keys: ["images/a.png", "docs/b.pdf", "other/c.txt"] });
    expect(received).toEqual({ images: ["images/a.png"], docs: ["docs/b.pdf"] });
    expect(dispatched!.error).toBeUndefined();
    expect(dispatched!.outcomes.map((outcome) => [outcome.eventId, outcome.trigger, outcome.status])).toEqual([
      ["files/docs/b.pdf", "docs", "completed"],
      ["files/images/a.png", "images", "completed"],
      ["files/other/c.txt", "", "completed"],
    ]);
    expect(app.logs.filter((entry) => entry.message === "trigger.event.unmatched")).toEqual([expect.objectContaining({ level: "warn", kind: "bucket", eventId: "files/other/c.txt" })]);
  });
});

describe("concurrency and deadlines", () => {
  test("with the deadline 2 seconds away and a 30s timeout, the signal aborts at about 1.5 seconds and the event fails", async () => {
    let abortedAfter: number | undefined;
    await start({
      slow: trigger({
        source: testSource(),
        options: { timeout: "30s" },
        handle: ({ signal }) => {
          const began = Date.now();
          return new Promise((_, reject) => signal.addEventListener("abort", () => ((abortedAfter = Date.now() - began), reject(signal.reason))));
        },
      }),
    });
    const dispatched = await dispatchPlatformEvent("lambda", testDelivery([{ id: "e1" }]), { deadline: Date.now() + 2000 });
    expect(abortedAfter).toBeGreaterThanOrEqual(1400);
    expect(abortedAfter).toBeLessThan(1900);
    expect(dispatched!.outcomes[0]).toMatchObject({ eventId: "e1", status: "failed" });
    expect((dispatched!.outcomes[0]!.error as Error).message).toMatch(/^Trigger slow timed out after 1[45]\d\d ms$/);
  });

  test("events run with the trigger's concurrency", async () => {
    let running = 0;
    let most = 0;
    await start({
      pair: trigger({
        source: testSource(),
        options: { concurrency: 2 },
        handle: async () => {
          most = Math.max(most, ++running);
          await Bun.sleep(20);
          running--;
        },
      }),
    });
    await dispatchPlatformEvent("lambda", testDelivery([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]));
    expect(most).toBe(2);
  });
});

describe("results and logs", () => {
  test("the outcomes go to the source's result; without one, a failed event fails the invocation; each event logs its start and outcome", async () => {
    const results: TriggerOutcome[][] = [];
    registerProjectFeatures([sourceFeature(bucketSource({ result: (outcomes) => (results.push([...outcomes]), { handled: outcomes.length }) }) as never)]);
    const app = await start({
      images: trigger({ source: { kind: "bucket", bucket: "files" }, handle: ({ event }) => (event.subject === "bad" ? Promise.reject(new Error("boom")) : undefined) }),
      plain: trigger({ source: testSource(), handle: () => Promise.reject(new Error("boom")) }),
    });
    const answered = await dispatchPlatformEvent("lambda", { bucket: "files", keys: ["good", "bad"] });
    expect(answered!.response).toEqual({ handled: 2 });
    expect(results[0]!.map((outcome) => outcome.status)).toEqual(["completed", "failed"]);
    expect(answered!.error).toBeUndefined();
    expect(app.logs.filter((entry) => String(entry.message).startsWith("trigger.event.") && entry.eventId === "files/good")).toEqual([
      expect.objectContaining({ message: "trigger.event.started", trigger: "images", kind: "bucket", eventId: "files/good", attempt: 1 }),
      expect.objectContaining({ message: "trigger.event.completed", trigger: "images", kind: "bucket", eventId: "files/good", attempt: 1, durationMs: expect.any(Number) }),
    ]);
    expect(app.logs.find((entry) => entry.message === "trigger.event.failed" && entry.eventId === "files/bad")).toMatchObject({ level: "warn", trigger: "images", kind: "bucket", attempt: 1, durationMs: expect.any(Number), error: { message: "boom" } });
    const failed = await dispatchPlatformEvent("lambda", { quickservicets: { source: "test", events: [{ id: "x" }] } });
    // The test source answers with a partial batch response, so the invocation itself succeeds.
    expect(failed!.response).toEqual({ batchItemFailures: [{ itemIdentifier: "x" }] });
  });

  test("a source without result fails the invocation when an event failed", async () => {
    registerProjectFeatures([sourceFeature(bucketSource() as never)]);
    await start({ images: trigger({ source: { kind: "bucket", bucket: "files" }, handle: () => Promise.reject(new Error("boom")) }) });
    const dispatched = await dispatchPlatformEvent("lambda", { bucket: "files", keys: ["a"] });
    expect(dispatched!.error!.message).toBe("1 of 1 bucket events failed: files/a");
  });
});
