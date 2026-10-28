import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { job } from "./jobs/job.ts";
import { connectedMemory, jobInstance, START } from "./jobs/test-support.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import { configureMetrics, coreInstruments, currentMeter, DURATION_BUCKETS, metricsEnabled, noopMeter, setMeter } from "./metering.ts";
import { recordingMeter } from "./tracing-test-support.ts";

const silent = { info() {}, warn() {}, error() {} };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  configureMetrics(undefined);
});

async function setUp(features: Record<string, () => void>) {
  let previous: string | undefined;
  for (const [key, setup] of Object.entries(features)) {
    registerNative(defineFeature({ key, docs: { summary: "Test." }, ...(previous ? { after: [previous] } : {}), setup }));
    cleanups.push(() => unregisterNative(key));
    previous = key;
  }
  const config = resolveConfig({ database: memoryAdapter(), logger: silent, ...Object.fromEntries(Object.keys(features).map((key) => [key, {}])) } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  return lifecycle;
}

describe("the meter interface", () => {
  test("without a meter nothing is enabled and the no-op meter records nothing; setMeter works once and only during setup", async () => {
    expect(metricsEnabled()).toBe(false);
    expect(currentMeter()).toBe(noopMeter);
    noopMeter.counter("x", { description: "x", unit: "1" }).add(1);
    noopMeter.histogram("x", { description: "x", unit: "s" }).record(1);

    const meter = recordingMeter();
    await setUp({ "meter-a": () => setMeter(meter) });
    expect(metricsEnabled()).toBe(true);
    expect(currentMeter()).toBe(meter as never);
    expect(() => setMeter(meter)).toThrow("setMeter() is only available during feature setup");

    const failure = await setUp({ "meter-b": () => setMeter(recordingMeter()), "meter-c": () => setMeter(recordingMeter()) }).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toBe("meter-c failed in setup: A meter is already set by meter-b");
  });
});

describe("job instruments and buckets", () => {
  test("a failing job records quickservicets.job.duration with status failed, and duration histograms use the default buckets", async () => {
    const meter = recordingMeter();
    configureMetrics({ owner: "test", meter, tenantAttribute: false });
    const database = await connectedMemory();
    const { runner } = jobInstance({ broken: job({ every: "1h" }, async () => { throw new Error("no"); }) }, database);
    await runner.run({ job: "broken", trigger: "schedule", scheduledAt: new Date(START), attempt: 1 });
    const durations = meter.named("quickservicets.job.duration")!;
    expect(durations.values).toHaveLength(1);
    expect(durations.values[0]!.attributes).toEqual({ "quickservicets.job.name": "broken", "quickservicets.job.status": "failed" });
    coreInstruments();
    for (const name of ["http.server.request.duration", "http.client.request.duration", "db.client.operation.duration", "quickservicets.job.duration", "quickservicets.queue.message.duration"]) {
      expect(meter.named(name)!.options).toMatchObject({ unit: "s", buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10] });
    }
    expect(DURATION_BUCKETS).toHaveLength(14);
  });
});
