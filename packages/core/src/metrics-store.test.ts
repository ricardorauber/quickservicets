import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import { configureTransactions } from "./transactions.ts";
import { fakeClock } from "./jobs/test-support.ts";
import metricsFeature, { MEMORY_WORKERS_WARNING, MISSING_ENTITY, setMetricsClock } from "./features/metrics/index.ts";
import { metricWindowEntity } from "./features/metrics/model.ts";
import { MetricsRuntime } from "./features/metrics/runtime.ts";
import { databaseMetricsStore, type MetricsStore } from "./features/metrics/store.ts";
import { createSqliteTables } from "./testing/sql.ts";

const START = Date.parse("2026-10-28T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const model = metricWindowEntity();
const silent = { info() {}, warn() {}, error() {} };

afterEach(() => setMetricsClock(undefined));

async function sqlite(): Promise<DatabaseAdapter> {
  const adapter = sqliteAdapter({ path: join(mkdtempSync(join(tmpdir(), "qs-metrics-")), "data.db") });
  await adapter.connect([model]);
  await createSqliteTables((adapter as unknown as { client: never }).client, [model]);
  configureTransactions(adapter, silent);
  return adapter;
}

const settings = { windowMs: MINUTE, retentionMs: 2 * HOUR, rollupMs: HOUR, rollupRetentionMs: 7 * 24 * HOUR, by: ["route", "tenant"] as ("route" | "tenant")[], maxSeries: 10_000, onOverflow: () => {} };

function runtime(store: MetricsStore | undefined, instance: string, clock = fakeClock(START), logger: { info(entry: LogEntry): void; warn(entry: LogEntry): void; error(entry: LogEntry): void } = silent) {
  return new MetricsRuntime({ settings, clock, logger, instance, ...(store ? { store } : {}) });
}

const request = (route = "/posts", status = 200) => ({ method: "GET", route, status, durationMs: 12 });
const rows = async (adapter: DatabaseAdapter) => (await adapter.findMany(model, { where: [], sort: [{ field: "windowStart", direction: "asc" }], limit: 10_000, offset: 0 })).data;

describe("the MetricWindow entity and the startup check", () => {
  test("the database store contributes the shared entity with its indexes; starting without it fails", async () => {
    const contribute = metricsFeature.entities as unknown as (context: { models: never[]; options: { store: string } }) => unknown[];
    expect(contribute({ models: [], options: { store: "memory" } })).toEqual([]);
    const [entity] = contribute({ models: [], options: { store: "database" } }) as ReturnType<typeof metricWindowEntity>[];
    expect(entity).toMatchObject({ key: "MetricWindow", name: "metric-windows", tableName: "metric_windows", internal: true, system: true });
    expect(entity!.indexes).toEqual([{ fields: ["instance", "resolution", "windowStart", "seriesKey"], unique: true }, { fields: ["resolution", "windowStart"] }]);
    expect(entity!.fields.map((field) => field.name)).toEqual(["instance", "resolution", "windowStart", "seriesKey", "route", "tenant", "user", "requests", "errors", "clientErrors", "sketch"]);

    const config = resolveConfig({ database: memoryAdapter(), logger: silent, metrics: {} } as ServiceConfig, { QS_METRICS_STORE: "database" });
    const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
    expect((await lifecycle.setup().then(() => undefined, (error: Error) => error))?.message).toBe(`metrics failed in setup: ${MISSING_ENTITY}`);
  });
});

describe("flushing", () => {
  test("closed windows are written on the boundary in batches, and a repeated write leaves the counts unchanged", async () => {
    const adapter = await sqlite();
    const store = databaseMetricsStore(adapter, model);
    const clock = fakeClock(START);
    const worker = runtime(store, "host:1:0", clock);
    for (let i = 0; i < 5; i++) worker.record(request());
    for (let i = 0; i < 1200; i++) worker.record(request(`/r${i}`));
    await clock.advance(MINUTE);
    await worker.rotate();
    expect((await rows(adapter)).length).toBe(1201);
    expect(worker.unflushed).toEqual([]);
    const posts = (await rows(adapter)).find((row) => row.route === "GET /posts")!;
    expect(posts).toMatchObject({ instance: "host:1:0", resolution: "minute", requests: 5, tenant: "-" });

    const window = { instance: "host:1:0", resolution: "minute" as const, windowStart: new Date(START), series: [{ seriesKey: "k", route: "GET /x", requests: 3, errors: 1, clientErrors: 0, sketch: { b: [10, 3], n: 3, s: 30, m: 12 } }] };
    await store.write([window]);
    await store.write([window]);
    const written = (await rows(adapter)).filter((row) => row.seriesKey === "k");
    expect(written).toHaveLength(1);
    expect(written[0]!.requests).toBe(3);
  });
});

describe("merging stored and local windows", () => {
  test("two instances sharing a database each serve 5 requests; after the flush either one reports 10", async () => {
    const adapter = await sqlite();
    const clock = fakeClock(START);
    const a = runtime(databaseMetricsStore(adapter, model), "host:1:0", clock);
    const b = runtime(databaseMetricsStore(adapter, model), "host:2:0", clock);
    for (let i = 0; i < 5; i++) {
      a.record(request());
      b.record(request());
    }
    await clock.advance(MINUTE);
    await Promise.all([a.rotate(), b.rotate()]);
    for (const worker of [a, b]) {
      const result = await worker.query({ last: "5m" });
      expect(result.series).toEqual([expect.objectContaining({ route: "GET /posts", requests: 10 })]);
    }
    a.record(request());
    expect((await a.query({ last: "5m" })).totals.requests).toBe(11);
    expect((await b.query({ last: "5m" })).totals.requests).toBe(10);
  });
});

describe("rollups", () => {
  test("minute rows older than the retention become hour rows, also with two rollups at once, and totals are unchanged", async () => {
    const adapter = await sqlite();
    const store = databaseMetricsStore(adapter, model);
    const clock = fakeClock(START);
    const worker = runtime(store, "host:1:0", clock);
    for (let minute = 0; minute < 180; minute++) {
      worker.record(request());
      await clock.advance(MINUTE);
      await worker.rotate();
    }
    const before = await worker.query({ from: START, to: START + 3 * HOUR });
    expect(before.totals.requests).toBe(180);
    const now = clock.now();
    const results = await Promise.all([1, 2].map(() => store.rollup({ before: new Date(now - 2 * HOUR), pruneBefore: new Date(now - 7 * 24 * HOUR), rollupMs: HOUR })));
    expect(results.reduce((sum, result) => sum + result.rolled, 0)).toBe(60);
    const stored = await rows(adapter);
    expect(stored.filter((row) => row.resolution === "hour").map((row) => row.requests)).toEqual([60]);
    expect(stored.filter((row) => row.resolution === "minute" && (row.windowStart as Date).getTime() < now - 2 * HOUR)).toEqual([]);
    expect((await worker.query({ from: START, to: START + 3 * HOUR })).totals.requests).toBe(180);
    expect(await store.prune({ resolution: "hour", before: new Date(now) })).toBe(1);
  });
});

describe("failures, the warning and the request path", () => {
  test("a failing store keeps at most 10 windows, logs the dropped ones, and flushes them when it returns", async () => {
    const adapter = await sqlite();
    const real = databaseMetricsStore(adapter, model);
    let down = true;
    const store: MetricsStore = { ...real, write: (windows) => (down ? Promise.reject(new Error("database down")) : real.write(windows)) };
    const entries: LogEntry[] = [];
    const clock = fakeClock(START);
    const worker = runtime(store, "host:1:0", clock, { info() {}, warn() {}, error: (entry) => entries.push(entry) });
    const write = spyOn(store, "write");
    for (let minute = 0; minute < 12; minute++) {
      worker.record(request());
      expect(write).toHaveBeenCalledTimes(minute);
      await clock.advance(MINUTE);
      await worker.rotate();
    }
    expect(worker.unflushed).toHaveLength(10);
    const failures = entries.filter((entry) => entry.message === "metrics.flush.failed");
    expect(failures.reduce((sum, entry) => sum + (entry.dropped as number), 0)).toBe(2);
    expect(failures[0]).toMatchObject({ error: { message: "database down" } });
    down = false;
    await clock.advance(MINUTE);
    await worker.rotate();
    expect(worker.unflushed).toEqual([]);
    expect((await rows(adapter)).length).toBe(10);
  });

  test("several workers with the memory store log the warning once", async () => {
    const entries: LogEntry[] = [];
    const logger = { info() {}, warn: (entry: LogEntry) => entries.push(entry), error() {} };
    const config = resolveConfig({ database: postgresAdapter({ url: "postgres://localhost/none" }), logger, server: { workers: 2 }, metrics: {} } as ServiceConfig, {});
    for (const index of [0, 1]) {
      const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [], worker: { index, count: 2, runsScheduledWork: index === 0 } });
      await lifecycle.setup();
    }
    expect(entries.filter((entry) => entry.message === MEMORY_WORKERS_WARNING)).toHaveLength(1);
  });
});
