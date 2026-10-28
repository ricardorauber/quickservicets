# Usage metrics

> Count requests, errors and p50, p95 and p99 latency per route, tenant and user inside the service, share them across workers and replicas, and serve them at /_metrics as JSON and for Prometheus.

A product team wants to know which endpoints each customer uses, how often they fail and how slow they are, without running a metrics stack first. The `metrics` native counts every request inside the service itself, in time windows per route, tenant and optionally user, and serves the result at `GET /_metrics` as JSON for dashboards and in the Prometheus text format for scrapers. The options, variables, the tag, the hooks and the store contract are listed on the [metrics reference page](/reference/features/metrics/).

The samples come from the example project `examples/minimal/metrics`: two tenants, `acme` and `globex`, a feed that fails one time in five, and closed windows kept in the SQLite database.

```ts title="quickservicets.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: "data.db" }),
  // Closed windows go to the MetricWindow table, so every worker and replica reports the whole service.
  metrics: { store: "database" },
  tenancy: { source: "config", tenants: { acme: {}, globex: {} } },
});
```

```ts title="endpoints/posts/feed/get.ts"
import { HttpError, type Repositories, type ServiceRequest } from "@quickservicets/core";

let calls = 0;

/** The tenant's feed; one call in five fails, so the usage metrics have errors to count. */
export default async (repos: Repositories, req: ServiceRequest) => {
  calls += 1;
  if (calls % 5 === 0) throw new HttpError(503, "The feed is warming up");
  return (await repos.posts.list({ where: [], sort: [], limit: 20, offset: 0 })).data;
};
```

## What is measured

After each response is complete (or when an SSE stream or a socket closes), the core hands the request to the native as an observation: its method, matched route, status, duration, user and tenant. Each observation lands in the open window of its series, which keeps:

- `requests`: every request;
- `errors`: responses of status 500 and above;
- `clientErrors`: responses from 400 to 499;
- a latency sketch, which answers `p50`, `p95`, `p99` and `max` in milliseconds.

Recording is one map lookup, a few increments and one sketch insert, with no promise and no database call on the request path. Without `metrics`, the core registers no observer and does no work per request; any feature can observe requests the same way with `observeRequests(fn)` from `@quickservicets/core`.

## How quantiles are computed

Latencies go into a logarithmic bucket sketch with 1% relative accuracy between 0.1 ms and one hour (fewer than 2048 buckets): each value counts in the bucket `ceil(log_γ(value))` with γ = 1.01 / 0.99, so the value reported for any quantile is within 1% of an actual latency of that rank. Sketches merge by adding their bucket counts, so windows, series, workers and replicas combine without losing accuracy, unlike averages of percentiles.

## Windows and rollups

Windows last `window` (one minute). They close on a timer at each boundary, never on the request path; closed minute windows are kept for `retention` (two hours), then merged into rollup windows of `rollup.window` (one hour) kept for `rollup.retention` (seven days). A query over the last three hours reads hourly rollups for the older part and minute windows for the recent part, and counts every request.

## Dimensions and cardinality

`by` chooses the dimensions of each series: `route` (the method and route pattern, like `GET /posts/feed`, or `GET unmatched`), `tenant` (the tenant id or `-`) and `user` (the user id or `-`). The default is route and tenant; users are opt-in because many users mean many series.

Each window holds at most `maxSeries` series per worker (10000); further new series count in one series whose dimensions are all `other`, and the worker logs `metrics.series.overflow` once per window with the limit. Memory stays bounded at a few megabytes.

`exclude` lists route patterns that are not counted: by default the health routes, the metrics route and `/docs`.

## Stores across workers and replicas

With the default memory store each worker keeps its own windows, and the route answers for that worker only; several workers on the memory store log a warning once. With `store: "database"`, the build adds the shared, read-only `MetricWindow` entity (run `quickservicets migration add`), each worker writes its closed windows when the boundary passes (idempotent upserts in batches of 500, with its `hostname:pid:worker` instance), and queries merge the stored windows of every worker and replica with the reader's own open window. The hourly `metrics/rollup` job merges minute rows older than the retention into hour rows and prunes old hour rows, safely on several instances at once. When the database fails, a worker keeps up to 10 closed windows and logs `metrics.flush.failed` with the count it dropped.

## The JSON form

```bash
curl "localhost:3000/_metrics?last=1h&by=route,tenant&sort=p95&limit=10"
```

```json
{
  "from": "2026-10-28T09:00:00.000Z",
  "to": "2026-10-28T10:00:00.000Z",
  "window": "1m",
  "totals": { "requests": 10, "errors": 2, "clientErrors": 0, "errorRate": 0.2, "p50": 1.2, "p95": 3.4, "p99": 4.1, "max": 4.2 },
  "series": [{ "route": "GET /posts/feed", "tenant": "globex", "requests": 4, "errors": 1, "clientErrors": 0, "errorRate": 0.25, "p50": 1.2, "p95": 3.4, "p99": 4.1, "max": 4.2 }]
}
```

`last` (default `15m`, at most `rollup.retention`) or `from` and `to` choose the range; `route`, `tenant` and `user` filter by exact value; `sort` is `requests`, `errors`, `p95` or `p99`; `limit` is at most 1000. A bad parameter answers 400 `VALIDATION_ERROR` naming it.

## The Prometheus format

`?format=prometheus`, or an `Accept` header preferring `text/plain` or `application/openmetrics-text`, answers the text format 0.0.4: `quickservicets_http_requests_total` by method, route, status class (`2xx`, `5xx`) and tenant, and the `quickservicets_http_request_duration_seconds` histogram. These counters are cumulative per worker since it started, so a scraper computes rates over them; with several workers each sample carries `worker`. A scrape reaches one worker per connection, so run one worker per container for Prometheus, or export through the meter interface instead.

```yaml
scrape_configs:
  - job_name: quickservicets
    metrics_path: /_metrics
    params:
      format: [prometheus]
    authorization:
      credentials_file: /etc/prometheus/metrics-token
    static_configs:
      - targets: ["api.internal:3000"]
```

## Access control

Usage metrics reveal traffic and tenants. The route answers only addresses on `access.allow` (loopback and private networks by default), and 403 `Metrics are not available from this address` to others. With `access.token`, it also requires `Authorization: Bearer` with that token (compared in constant time), answering 401 otherwise; `allow: []` with a token accepts any address that has it. The route skips tenant resolution, `auth.required`, rate limits and load shedding, writes no request log entries and is not in the OpenAPI document.

## Usage metrics and the meter interface

The meter interface (`setMeter`) records the standard OpenTelemetry instruments (request and client durations, database operations, jobs, queues) and hands them to an exporter, usually an OpenTelemetry plugin sending them to a time-series database. Usage metrics answer a different question inside the service, without any backend: who used what, how often and how fast, per tenant and user, kept and queried by the service itself. Use the meter for infrastructure monitoring and alerting across services, and usage metrics for product questions, tenant reports and a quick view without a stack; both can run together.

## Cost

Recording adds one map lookup, a few increments and one sketch insert per request, within 3% of the baseline on the CRUD benchmark; without `metrics` there is no cost at all. Closing windows, flushing and rollups run on timers and in the job, never on the request path, and building a response yields to other requests every 1000 series.

## Customization

Every level of customization, as `examples/minimal/metrics` shows:

- Level 0: `metrics: {}` counts and serves with every default.
- Level 1: every option has a variable, like `QS_METRICS_BY=route`, `QS_METRICS_STORE=database` or `QS_METRICS_ACCESS_TOKEN`.
- Level 2: `@metrics off` on an endpoint or entity leaves its routes out, and `@metrics by=route` drops the tenant and user dimensions for them.
- Level 3: `record: ({ req, user, tenant, status }) => boolean` decides per request, like leaving out requests with `x-synthetic`.
- Level 4: `beforeRecord` changes or drops an observation (group `/reports/*` routes), and `onWindowClosed` receives each closed window to push elsewhere; a failing hook is logged and recording goes on.
- Level 5: a project `endpoints/_metrics/get.ts` replaces the route, reading the series with `queryMetrics(options)`.
- Level 6: a `MetricsStore` with `write`, `read` and `prune` replaces the memory and database stores, like one writing JSON lines.
- Level 7: `quickservicets eject metrics` copies the native into `features/metrics/`.

```ts
metrics: {
  record: ({ req }) => !req?.headers.has("x-synthetic"),
  onWindowClosed: [({ windowStart, series }) => console.log(JSON.stringify({ windowStart, series: series.length }))],
}
```

Next: [Configuration](/guides/configuration/).
