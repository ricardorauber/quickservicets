import { hostname } from "node:os";
import { defineFeature, duration, integer, list, object, observeRequests, oneOf, parseDuration, safeLog, string, systemClock, type JobClock, type RequestObservation } from "../public.ts";
import type { MetricsApi } from "./api.ts";
import { metricWindowEntity } from "./model.ts";
import type { MetricsQuery } from "./query.ts";
import { MetricsRuntime } from "./runtime.ts";
import { databaseMetricsStore, type DatabaseMetricsStore } from "./store.ts";
import type { Dimension } from "./windows.ts";

export type { MetricsApi } from "./api.ts";
export type { MetricsFigures, MetricsQuery, MetricsResult, MetricsSeries } from "./query.ts";
export { LatencySketch } from "./sketch.ts";
export type { EncodedSketch } from "./sketch.ts";
export { metricWindowEntity } from "./model.ts";
export type { MetricWindow } from "./model.ts";
export type { MetricsStore, StoredSeries, StoredWindow } from "./store.ts";

const options = object({
  window: duration().default("1m").describe("The length of each usage window."),
  retention: duration().default("2h").describe("How long minute windows are kept before they are rolled up."),
  rollup: object({
    window: duration().default("1h").describe("The length of each rollup window."),
    retention: duration().default("7d").describe("How long rollup windows are kept."),
  })
    .default({ window: "1h", retention: "7d" })
    .describe("Windows older than the retention are merged into longer ones."),
  by: list(oneOf(["route", "tenant", "user"]))
    .default(["route", "tenant"])
    .describe("The dimensions of each series: the route as its method and pattern (GET /posts), and the tenant and user ids (- when absent)."),
  maxSeries: integer().min(1).default(10000).describe("The most series per window and worker; further ones are counted in one series whose dimensions are all other."),
  exclude: list(string())
    .default(["/health/*", "/_metrics", "/docs"])
    .describe("Route patterns that are not counted; a pattern ending in /* covers every route under it."),
  store: oneOf(["memory", "database"])
    .default("memory")
    .describe("Where closed windows are kept: the worker's memory, or the MetricWindow table of the project's database, shared by every worker and replica."),
});

/** The startup error of a database store without its entity in the build. */
export const MISSING_ENTITY = 'metrics.store is "database", but the build did not include MetricWindow; rebuild and run quickservicets migration add';

/** The warning of several workers each keeping their own windows. */
export const MEMORY_WORKERS_WARNING = 'metrics uses per-worker memory; each worker reports its own requests; set metrics.store to "database" to combine them';

/** The clock windows close on; tests set a fake one. */
const clocks = { current: systemClock as JobClock };

/** Sets the clock usage windows use (the system clock without one); for tests. */
export function setMetricsClock(clock: JobClock | undefined): void {
  clocks.current = clock ?? systemClock;
}

/** Whether a route pattern matches an exclusion: exact, or under a `/*` prefix. */
function excludedBy(patterns: readonly string[]): (route: string | null) => boolean {
  const cache = new Map<string | null, boolean>();
  return (route) => {
    let excluded = cache.get(route);
    if (excluded === undefined) {
      excluded =
        route !== null &&
        patterns.some((pattern) => (pattern.endsWith("/*") ? route === pattern.slice(0, -2) || route.startsWith(pattern.slice(0, -1)) : route === pattern));
      if (cache.size < 10_000) cache.set(route, excluded);
    }
    return excluded;
  };
}

/** The running runtime of each set of resolved options, for the API. */
const runtimes = new WeakMap<object, MetricsRuntime>();

/** The database store and settings of the service running in this process, for the rollup job. */
let rollupTarget: { store: DatabaseMetricsStore; retentionMs: number; rollupMs: number; rollupRetentionMs: number; clock: JobClock } | undefined;

/**
 * Rolls the stored minute windows older than the retention into hour windows and prunes the hour windows older than
 * theirs; the `metrics/rollup` job runs it hourly. Resolves the counts, or a note when the store is not the database.
 */
export async function rollupStoredWindows(): Promise<{ rolled: number; pruned: number } | { skipped: string }> {
  const target = rollupTarget;
  if (!target) return { skipped: "metrics.store is not database" };
  const now = target.clock.now();
  return target.store.rollup({ before: new Date(now - target.retentionMs), pruneBefore: new Date(now - target.rollupRetentionMs), rollupMs: target.rollupMs });
}

/**
 * The `metrics` native: counts requests, errors and latency (p50, p95, p99) per route, tenant and optionally user in
 * time windows inside the service, fed by the core's request observer. Off unless `metrics: {}` (or
 * `QS_METRICS_ENABLED=true`) is set.
 */
const metricsFeature = defineFeature({
  key: "metrics",
  docs: { summary: "API usage metrics: requests, errors and p50, p95 and p99 latency per route, tenant and optionally user, in time windows inside the service." },
  options,
  // The shared table of closed windows exists only with the database store.
  entities: ({ options }) => (options.store === "database" ? [metricWindowEntity()] : []),
  jobs: "./jobs",
  setup(ctx) {
    const clock = clocks.current;
    const windowMs = parseDuration(ctx.options.window) ?? 60_000;
    const settings = {
      windowMs,
      retentionMs: parseDuration(ctx.options.retention) ?? 7_200_000,
      rollupMs: parseDuration(ctx.options.rollup.window) ?? 3_600_000,
      rollupRetentionMs: parseDuration(ctx.options.rollup.retention) ?? 604_800_000,
      by: ctx.options.by as Dimension[],
      maxSeries: ctx.options.maxSeries,
      onOverflow: (limit: number) => safeLog(ctx.logger, "warn", { timestamp: new Date(clock.now()).toISOString(), message: "metrics.series.overflow", limit }),
    };
    let store: DatabaseMetricsStore | undefined;
    rollupTarget = undefined;
    if (ctx.options.store === "database") {
      const model = ctx.models.find((candidate) => candidate.key === "MetricWindow" && candidate.system);
      if (!model) throw new Error(MISSING_ENTITY);
      store = databaseMetricsStore(ctx.config.database, model);
      rollupTarget = { store, retentionMs: settings.retentionMs, rollupMs: settings.rollupMs, rollupRetentionMs: settings.rollupRetentionMs, clock };
    } else if (ctx.config.server.workers > 1 && ctx.worker.runsScheduledWork) {
      safeLog(ctx.logger, "warn", { timestamp: new Date(clock.now()).toISOString(), message: MEMORY_WORKERS_WARNING });
    }
    const runtime = new MetricsRuntime({ settings, clock, logger: ctx.logger, instance: `${hostname()}:${process.pid}:${ctx.worker.index}`, ...(store ? { store } : {}) });
    runtimes.set(ctx.options, runtime);
    const excluded = excludedBy(ctx.options.exclude);
    const observe = (observation: RequestObservation) => {
      if (!excluded(observation.route)) runtime.record(observation);
    };
    let unsubscribe: (() => void) | undefined;
    let timer: unknown;
    // Windows close on a timer at each boundary, never on the request path; with the database store they are written then.
    const schedule = () => {
      const now = clock.now();
      const next = runtime.recorder.current.start + windowMs;
      timer = clock.setTimeout(() => {
        void runtime.rotate();
        schedule();
      }, Math.max(next - now, 1));
    };
    ctx.app.onStart(() => {
      unsubscribe = observeRequests(observe);
      schedule();
    });
    ctx.app.onStop(async () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      if (rollupTarget?.store === store) rollupTarget = undefined;
    });
  },
  api: (ctx): MetricsApi => ({
    query(query: MetricsQuery = {}) {
      const runtime = runtimes.get(ctx.options);
      if (!runtime) return Promise.reject(new Error("metrics is not running"));
      return runtime.query(query);
    },
  }),
});

export default metricsFeature;
export { metricsFeature };
