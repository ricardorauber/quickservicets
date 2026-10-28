import { hostname } from "node:os";
import { anyOf, boolean, cidr, defineFeature, duration, hook, integer, list, object, observeRequests, oneOf, parseDuration, provider, resolveOption, runAfterHooks, runBeforeHooks, safeLog, secret, string, systemClock, type FeatureHook, type JobClock, type OptionFunction, type RequestObservation } from "../public.ts";
import { figuresOf, type MetricsResult } from "./query.ts";
import type { MetricsStore } from "./store.ts";
import type { UsageWindow } from "./windows.ts";
import { metricsEndpoint } from "./route.ts";
import type { MetricsApi } from "./api.ts";
import { metricWindowEntity } from "./model.ts";
import type { MetricsQuery, MetricsSeries } from "./query.ts";
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
  store: anyOf(oneOf(["memory", "database"]), provider<MetricsStore>("MetricsStore", ["write", "read", "prune"]))
    .default("memory")
    .describe("Where closed windows are kept: the worker's memory, the MetricWindow table of the project's database shared by every worker and replica, or a MetricsStore of the project."),
  record: boolean()
    .default(true)
    .perRequest()
    .describe("Whether a completed request is counted; a function of the request, its user, tenant and status decides per request, like leaving out synthetic checks."),
  beforeRecord: hook<RequestObservation | null, undefined>().describe("Runs before an observation is counted; it may return a changed one (a grouped route, say) or null to skip it."),
  onWindowClosed: hook<WindowClosed, undefined>().describe("Runs once per closed window and worker with its start and series, for pushing them elsewhere; a failure is logged."),
  path: string().default("/_metrics").describe("The path of the route serving the metrics as JSON and in the Prometheus text format."),
  access: object({
    allow: list(cidr())
      .default(["loopback", "private"])
      .describe("The addresses that may read the metrics; an empty list allows any address that has the token."),
    token: secret().optional().describe("Requires this bearer token in the Authorization header of the metrics route."),
  })
    .default({ allow: ["loopback", "private"] })
    .describe("Who may read the metrics route."),
});

/** What `onWindowClosed` hooks receive: the window's start and its series with their figures. */
export interface WindowClosed {
  windowStart: Date;
  series: MetricsSeries[];
}

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

/** A closed window as `onWindowClosed` hooks receive it. */
function windowClosed(window: UsageWindow): WindowClosed {
  return {
    windowStart: new Date(window.start),
    series: [...window.series.values()].map((series) => ({
      ...(series.route !== undefined ? { route: series.route } : {}),
      ...(series.tenant !== undefined ? { tenant: series.tenant } : {}),
      ...(series.user !== undefined ? { user: series.user } : {}),
      ...figuresOf(series),
    })),
  };
}

/**
 * Whether each route is counted and with which dimensions, from its `@metrics` tag, decided once per method and route:
 * `@metrics off` leaves it out, and `@metrics by=...` keeps only the dimensions it lists that `metrics.by` has.
 */
function routeSettings(by: readonly Dimension[]): (method: string, route: string | null) => { on: boolean; by: readonly Dimension[] } {
  const decisions = new Map<string, { on: boolean; by: readonly Dimension[] }>();
  const counted = { on: true, by };
  return (method, route) => {
    if (route === null) return counted;
    const key = `${method} ${route}`;
    let decision = decisions.get(key);
    if (!decision) {
      // A request-shaped target finds the tags of endpoints and of the entities behind generated routes.
      const target = metricsFeature.optionsFor({ method, route, raw: undefined } as never);
      const tagged = (target.by as Dimension[] | undefined) ?? by;
      decision = target.on === false ? { on: false, by } : { on: true, by: target.on === true ? by.filter((dimension) => tagged.includes(dimension)) : by };
      if (decisions.size < 10_000) decisions.set(key, decision);
    }
    return decision;
  };
}

/** The running runtime of each set of resolved options, for the API. */
const runtimes = new WeakMap<object, MetricsRuntime>();

/** The runtime of the service running in this process, for `queryMetrics`. */
let current: MetricsRuntime | undefined;

/**
 * The usage series of the running service, as `ctx.feature("metrics").query(options)` answers them, for project
 * endpoints that replace the metrics route; rejects while the `metrics` native is not running.
 */
export function queryMetrics(options: MetricsQuery = {}): Promise<MetricsResult> {
  if (!current) return Promise.reject(new Error("metrics is not running; add metrics: {} to quickservicets.config.ts"));
  return current.query(options);
}

/** The database store and settings of the service running in this process, for the rollup job. */
let rollupTarget: { store: DatabaseMetricsStore | MetricsStore; database: boolean; retentionMs: number; rollupMs: number; rollupRetentionMs: number; clock: JobClock } | undefined;

/**
 * Rolls the stored minute windows older than the retention into hour windows and prunes the hour windows older than
 * theirs; the `metrics/rollup` job runs it hourly. Resolves the counts, or a note when the store is not the database.
 */
export async function rollupStoredWindows(): Promise<{ rolled: number; pruned: number } | { skipped: string }> {
  const target = rollupTarget;
  if (!target) return { skipped: "metrics.store is memory" };
  const now = target.clock.now();
  if (target.database) return (target.store as DatabaseMetricsStore).rollup({ before: new Date(now - target.retentionMs), pruneBefore: new Date(now - target.rollupRetentionMs), rollupMs: target.rollupMs });
  // A project's store receives the workers' rollups; the job prunes what they replaced and what expired.
  const rolled = await target.store.prune({ resolution: "minute", before: new Date(now - target.retentionMs) });
  const pruned = await target.store.prune({ resolution: "hour", before: new Date(now - target.rollupRetentionMs) });
  return { rolled, pruned };
}

/**
 * The `metrics` native: counts requests, errors and latency (p50, p95, p99) per route, tenant and optionally user in
 * time windows inside the service, fed by the core's request observer. Off unless `metrics: {}` (or
 * `QS_METRICS_ENABLED=true`) is set.
 */
const metricsFeature = defineFeature({
  key: "metrics",
  docs: {
    summary: "API usage metrics: requests, errors and p50, p95 and p99 latency per route, tenant and optionally user, in time windows inside the service.",
    sections: [
      {
        title: "The metrics route",
        text: [
          "`GET /_metrics` (the `path` option) answers JSON for dashboards and people: `last` (default `15m`, at most `rollup.retention`) or `from` and `to` (ISO 8601), `by`, the exact filters `route`, `tenant` and `user`, `sort` (`requests`, `errors`, `p95` or `p99`) and `limit` (default 100, at most 1000); a bad parameter answers 400 `VALIDATION_ERROR` naming it. The body is `{ from, to, window, totals, series }`, with latencies in milliseconds and `errorRate` as errors divided by requests.",
          "",
          "With `format=prometheus`, or an `Accept` header preferring `text/plain` or `application/openmetrics-text`, it answers the Prometheus text format 0.0.4: `quickservicets_http_requests_total` by method, route, status class and (when `by` lists it) tenant, and the `quickservicets_http_request_duration_seconds` histogram. These counters are cumulative per worker since it started, and with several workers every sample carries `worker`; a scraper reaches one worker per connection, so run one worker per container for scraping, or export through a meter set with `setMeter` (an OpenTelemetry exporter) instead.",
          "",
          "The route answers only `access.allow` addresses (loopback and private networks by default; 403 `Metrics are not available from this address` otherwise) and, with `access.token`, only requests with `Authorization: Bearer <token>` (401 otherwise). It skips tenant resolution, `auth.required`, rate limits and load shedding, writes no request log entries and is not in the OpenAPI document.",
        ].join("\n"),
      },
    ],
  },
  options,
  tags: {
    metrics: {
      on: ["entity", "endpoint"],
      options: ["by"],
      description: "`@metrics off` leaves the routes of an entity or endpoint out of the usage metrics, and `@metrics by=route` counts them with fewer dimensions than `metrics.by`.",
      example: "/** @metrics by=route */\nexport type Post = { title: string };",
    },
  },
  // The shared table of closed windows exists only with the database store.
  entities: ({ options }) => (options.store === "database" ? [metricWindowEntity()] : []),
  jobs: "./jobs",
  // The metrics route skips rate limits, load shedding and tenant resolution when those natives run.
  after: ["security", "tenancy", "auth"],
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
    let store: DatabaseMetricsStore | MetricsStore | undefined;
    rollupTarget = undefined;
    const projectStore = typeof ctx.options.store === "object" ? (ctx.options.store as MetricsStore) : undefined;
    if (projectStore) {
      store = projectStore;
      rollupTarget = { store, database: false, retentionMs: settings.retentionMs, rollupMs: settings.rollupMs, rollupRetentionMs: settings.rollupRetentionMs, clock };
    } else if (ctx.options.store === "database") {
      const model = ctx.models.find((candidate) => candidate.key === "MetricWindow" && candidate.system);
      if (!model) throw new Error(MISSING_ENTITY);
      store = databaseMetricsStore(ctx.config.database, model);
      rollupTarget = { store, database: true, retentionMs: settings.retentionMs, rollupMs: settings.rollupMs, rollupRetentionMs: settings.rollupRetentionMs, clock };
    } else if (ctx.config.server.workers > 1 && ctx.worker.runsScheduledWork) {
      safeLog(ctx.logger, "warn", { timestamp: new Date(clock.now()).toISOString(), message: MEMORY_WORKERS_WARNING });
    }
    const { beforeRecord, onWindowClosed } = ctx.options as unknown as { beforeRecord: FeatureHook<RequestObservation | null, undefined>[]; onWindowClosed: FeatureHook<WindowClosed, undefined>[] };
    const runtime = new MetricsRuntime({
      settings,
      clock,
      logger: ctx.logger,
      instance: `${hostname()}:${process.pid}:${ctx.worker.index}`,
      ...(store ? { store } : {}),
      ...(projectStore ? { rollupLocally: true } : {}),
      // The hooks see each closed window once per worker, outside the response path; a failure is logged.
      ...(onWindowClosed.length > 0 ? { onWindowClosed: (window: UsageWindow) => void runAfterHooks(onWindowClosed, windowClosed(window), undefined) } : {}),
    });
    runtimes.set(ctx.options, runtime);
    const excluded = excludedBy([...ctx.options.exclude, ctx.options.path]);
    const routes = routeSettings(settings.by);
    const decide = ctx.options.record as boolean | OptionFunction<boolean>;
    const count = (observation: RequestObservation) => {
      if (excluded(observation.route)) return;
      const route = routes(observation.method, observation.route);
      if (!route.on) return;
      runtime.record(observation, route.by);
    };
    // Without a record function or beforeRecord hooks, recording stays synchronous: one lookup, increments and an insert.
    const slow = typeof decide === "function" || beforeRecord.length > 0;
    const observe = !slow
      ? count
      : (observation: RequestObservation) =>
          void (async () => {
            if (typeof decide === "function") {
              const req = observation.req;
              const allowed = await resolveOption(decide, { req, user: req?.user, tenant: req?.tenant, status: observation.status } as never);
              if (allowed === false) return;
            }
            const changed = beforeRecord.length > 0 ? await runBeforeHooks(beforeRecord, observation as RequestObservation | null, undefined) : observation;
            if (changed) count(changed);
          })().catch((error: unknown) =>
            safeLog(ctx.logger, "error", { timestamp: new Date(clock.now()).toISOString(), message: "metrics.record.failed", error: { message: (error as Error)?.message ?? String(error) } }),
          );
    const path = ctx.options.path;
    ctx.app.route(
      "GET",
      path,
      metricsEndpoint(() => runtimes.get(ctx.options), {
        access: ctx.options.access as { allow: string[]; token?: string },
        window: ctx.options.window,
        by: settings.by,
        maxRangeMs: settings.rollupRetentionMs,
        ...(ctx.config.server.workers > 1 ? { worker: ctx.worker.index } : {}),
      }),
      { log: false, auth: false },
    );
    const enabled = (key: string) => ctx.config.features.some((feature) => feature.key === key);
    if (enabled("security")) ctx.feature("security").exempt(path, ["rateLimit", "loadShedding"]);
    if (enabled("tenancy")) ctx.feature("tenancy").exempt(path);
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
      current = runtime;
      unsubscribe = observeRequests(observe);
      schedule();
    });
    ctx.app.onStop(async () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      if (rollupTarget?.store === store) rollupTarget = undefined;
      if (current === runtime) current = undefined;
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
