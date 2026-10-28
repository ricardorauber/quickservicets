import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { setEnvValues } from "./env-vars.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import { recordingTracer } from "./tracing-test-support.ts";
import { activeSpan, configureTracing, formatTraceparent, noopTracer, parseTraceparent, setTracer, spanAttributes, startSpan, tracingEnabled, withSpan, type Tracer } from "./tracing.ts";

type Log = { info(entry: LogEntry): void; warn(entry: LogEntry): void; error(entry: LogEntry): void };
const silent: Log = { info() {}, warn() {}, error() {} };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  configureTracing(undefined);
});

/** Runs the setups of the given test features, enabled in this order. */
async function setUp(features: Record<string, (ctx: { logger: Log }) => void>, logger: { info(entry: LogEntry): void; warn(entry: LogEntry): void; error(entry: LogEntry): void } = silent) {
  let previous: string | undefined;
  for (const [key, setup] of Object.entries(features)) {
    registerNative(defineFeature({ key, docs: { summary: "Test." }, ...(previous ? { after: [previous] } : {}), setup: setup as never }));
    cleanups.push(() => unregisterNative(key));
    previous = key;
  }
  const config = resolveConfig({ database: memoryAdapter(), logger, ...Object.fromEntries(Object.keys(features).map((key) => [key, {}])) } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  return { config, lifecycle };
}

describe("the tracer interface", () => {
  test("without a tracer, spans are the shared non-recording span and withSpan creates no async context", () => {
    const span = startSpan("x", { kind: "internal" });
    expect(span).toBe(noopTracer.startSpan("y", {}));
    expect(span.isRecording()).toBe(false);
    expect(span.setAttribute("a", 1)).toBe(span);
    expect(tracingEnabled()).toBe(false);
    const run = spyOn(AsyncLocalStorage.prototype, "run");
    try {
      expect(withSpan(span, () => 42)).toBe(42);
      expect(run).not.toHaveBeenCalled();
      expect(activeSpan()).toBeUndefined();
    } finally {
      run.mockRestore();
    }
  });

  test("a tracer set in a feature's setup receives startSpan; a second one fails startup, and setTracer outside setup throws", async () => {
    const tracer = recordingTracer();
    await setUp({ "trace-a": () => setTracer(tracer) });
    expect(tracingEnabled()).toBe(true);
    startSpan("work", { kind: "internal", attributes: { a: 1 } });
    expect(tracer.spans.map((span) => [span.name, span.kind, span.attributes.a, span.parent])).toEqual([["work", "internal", 1, null]]);
    expect(() => setTracer(tracer)).toThrow("setTracer() is only available during feature setup");

    const failure = await setUp({ "trace-b": () => setTracer(recordingTracer()), "trace-c": () => setTracer(recordingTracer()) }).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toBe("trace-c failed in setup: A tracer is already set by trace-b");
  });

  test("the app makes the service's tracer current, and a service without one goes back to the no-op tracer", async () => {
    const tracer: Tracer = recordingTracer();
    const { config, lifecycle } = await setUp({ "trace-d": () => setTracer(tracer) });
    createApp({ models: [], crudRoutes: [], endpoints: [], hooks: new Map(), config, server: lifecycle.server });
    expect(tracingEnabled()).toBe(true);
    const plain = await setUp({ "trace-e": () => {} });
    expect(tracingEnabled()).toBe(false);
    createApp({ models: [], crudRoutes: [], endpoints: [], hooks: new Map(), config: plain.config, server: plain.lifecycle.server });
    expect(tracingEnabled()).toBe(false);
  });
});

describe("the active span", () => {
  test("follows async continuations and promise chains started inside withSpan, and becomes the default parent", async () => {
    const tracer = recordingTracer();
    configureTracing({ owner: "test", tracer });
    const span = startSpan("outer", { kind: "server" });
    const seen = await withSpan(span, async () => {
      await Bun.sleep(1);
      return activeSpan();
    });
    expect(seen).toBe(span);
    const chained = await withSpan(span, () => Promise.resolve().then(() => Bun.sleep(1)).then(() => activeSpan()));
    expect(chained).toBe(span);
    expect(activeSpan()).toBeUndefined();
    const child = withSpan(span, () => startSpan("child", { kind: "internal" }));
    expect(tracer.named("child")[0]!.parent).toEqual(span.context());
    expect(child.context().traceId).toBe(span.context().traceId);
    withSpan(span, () => startSpan("root", { parent: null }));
    expect(tracer.named("root")[0]!.parent).toBeNull();
  });
});

describe("trace context", () => {
  test("parses valid traceparent headers, refuses invalid ones and round-trips", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const context = parseTraceparent(header);
    expect(context).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1 });
    expect(formatTraceparent(context!)).toBe(header);
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeUndefined();
    expect(parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent("garbage")).toBeUndefined();
  });

  test("keeps tracestate as given up to 512 characters", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
    expect(parseTraceparent(header, "vendor=a,other=b")?.traceState).toBe("vendor=a,other=b");
    expect(parseTraceparent(header, "x".repeat(513))?.traceState).toBeUndefined();
    expect(parseTraceparent(header)?.traceFlags).toBe(0);
  });
});

describe("log correlation", () => {
  test("with a tracer and an active span, entries get traceId and spanId unless they set them; without a tracer they are unchanged", async () => {
    const entries: LogEntry[] = [];
    const keep = (entry: LogEntry) => void (entry.feature?.toString().startsWith("trace-") && entries.push(entry));
    const logger = { info: keep, warn: keep, error: keep };
    const tracer = recordingTracer();
    let log: Log | undefined;
    await setUp({ "trace-log": (ctx) => ((log = ctx.logger), setTracer(tracer)) }, logger);
    const span = startSpan("request", { kind: "server" });
    withSpan(span, () => log!.info({ message: "x" }));
    withSpan(span, () => log!.info({ message: "own", traceId: "t", spanId: "s" }));
    log!.info({ message: "outside" });
    expect(entries[0]).toMatchObject({ message: "x", traceId: span.context().traceId, spanId: span.context().spanId });
    expect(entries[1]).toMatchObject({ traceId: "t", spanId: "s" });
    expect(entries[2]!.traceId).toBeUndefined();

    entries.length = 0;
    let plainLog: Log | undefined;
    await setUp({ "trace-plain": (ctx) => void (plainLog = ctx.logger) }, logger);
    withSpan(startSpan("x"), () => plainLog!.info({ message: "x" }));
    expect(entries).toEqual([{ message: "x", feature: "trace-plain" }]);
  });
});

describe("span attributes", () => {
  test("drop keys named like credentials and mask declared secret values", () => {
    setEnvValues({ STRIPE_KEY: "sk_live_1234567890" }, ["STRIPE_KEY"]);
    try {
      const attributes = spanAttributes({ "http.request.header.authorization": "Bearer x", note: "sk_live_1234567890", "url.path": "/a", count: 2, skipped: undefined });
      expect(attributes).toEqual({ note: "[secret]", "url.path": "/a", count: 2 });
      expect(spanAttributes({ "user.password": "p", api_key: "k", list: ["sk_live_1234567890", "a"] })).toEqual({ list: ["[secret]", "a"] });
    } finally {
      setEnvValues({});
    }
  });
});
