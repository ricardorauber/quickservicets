import { defineFeature, duration, integer, list, object, observeRequests, oneOf, parseDuration, safeLog, string, systemClock, type JobClock, type RequestObservation } from "../public.ts";
import type { MetricsApi } from "./api.ts";
import { queryWindows, type MetricsQuery } from "./query.ts";
import { UsageRecorder, type Dimension } from "./windows.ts";

export type { MetricsApi } from "./api.ts";
export type { MetricsFigures, MetricsQuery, MetricsResult, MetricsSeries } from "./query.ts";
export { LatencySketch } from "./sketch.ts";
export type { EncodedSketch } from "./sketch.ts";

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
});

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

/** The running recorder of each set of resolved options, for the API. */
const recorders = new WeakMap<object, { recorder: UsageRecorder; clock: JobClock }>();

/**
 * The `metrics` native: counts requests, errors and latency (p50, p95, p99) per route, tenant and optionally user in
 * time windows inside the service, fed by the core's request observer. Off unless `metrics: {}` (or
 * `QS_METRICS_ENABLED=true`) is set.
 */
const metricsFeature = defineFeature({
  key: "metrics",
  docs: { summary: "API usage metrics: requests, errors and p50, p95 and p99 latency per route, tenant and optionally user, in time windows inside the service." },
  options,
  setup(ctx) {
    const clock = clocks.current;
    const windowMs = parseDuration(ctx.options.window) ?? 60_000;
    const recorder = new UsageRecorder(
      {
        windowMs,
        retentionMs: parseDuration(ctx.options.retention) ?? 7_200_000,
        rollupMs: parseDuration(ctx.options.rollup.window) ?? 3_600_000,
        rollupRetentionMs: parseDuration(ctx.options.rollup.retention) ?? 604_800_000,
        by: ctx.options.by as Dimension[],
        maxSeries: ctx.options.maxSeries,
        onOverflow: (limit) => safeLog(ctx.logger, "warn", { timestamp: new Date(clock.now()).toISOString(), message: "metrics.series.overflow", limit }),
      },
      clock.now(),
    );
    recorders.set(ctx.options, { recorder, clock });
    const excluded = excludedBy(ctx.options.exclude);
    const observe = (observation: RequestObservation) => {
      if (!excluded(observation.route)) recorder.record(observation);
    };
    let unsubscribe: (() => void) | undefined;
    let timer: unknown;
    // Windows close on a timer at each boundary, never on the request path.
    const schedule = () => {
      const now = clock.now();
      const next = recorder.current.start + windowMs;
      timer = clock.setTimeout(() => {
        recorder.rotate(clock.now());
        schedule();
      }, Math.max(next - now, 1));
    };
    ctx.app.onStart(() => {
      unsubscribe = observeRequests(observe);
      schedule();
    });
    ctx.app.onStop(() => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    });
  },
  api: (ctx): MetricsApi => ({
    query(query: MetricsQuery = {}) {
      const running = recorders.get(ctx.options);
      if (!running) return Promise.reject(new Error("metrics is not running"));
      return queryWindows(running.recorder.windows(), running.recorder.settings, query, running.clock.now());
    },
  }),
});

export default metricsFeature;
export { metricsFeature };
