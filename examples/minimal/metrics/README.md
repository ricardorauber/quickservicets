# metrics

The smallest project that shows the `metrics` native: every request is counted in one-minute windows per route and tenant, with its errors and its latency, and `GET /posts?fail=1` answers 500 so there are errors to count.

```bash
bun run test
```

## Level 0: enable

Turn the native on; every request is counted from the next one on:

```ts
export default defineConfig({ database: memoryAdapter(), metrics: {} });
```

Another feature reads the windows with `ctx.feature("metrics").query({ last: "15m" })`.

## Level 1: options and environment

`window`, `retention`, `rollup`, `by`, `maxSeries` and `exclude` shape the windows and series, `store: "database"` keeps closed windows in the project's database so every worker and replica reads them all, and every option has a `QS_*` variable:

```ts
metrics: { by: ["route", "tenant", "user"], retention: "6h" }
```

```bash
QS_METRICS_MAX_SERIES=20000 bun .generated/server.ts
```

## Level 2: tags

Not applicable: the `metrics` native has no tags yet.

## Level 3: per request

Not applicable: the `metrics` native has no per-request options yet.

## Level 4: hooks and events

Not applicable: the `metrics` native has no hooks yet; `observeRequests` from `@quickservicets/core` receives every completed request:

```ts
const stop = observeRequests(({ method, route, status, durationMs }) => count(method, route, status, durationMs));
```

## Level 5: override files

Not applicable: the `metrics` native has no routes to override yet.

## Level 6: replace the implementation

Not applicable: the `metrics` native keeps its windows in the worker's memory or in the `MetricWindow` table, and has no replaceable store yet.

## Level 7: eject

Copy the native into the project, where it replaces the built-in one:

```bash
bunx quickservicets eject metrics
```
