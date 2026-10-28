# metrics

> API usage metrics: requests, errors and p50, p95 and p99 latency per route, tenant and optionally user, in time windows inside the service.

API usage metrics: requests, errors and p50, p95 and p99 latency per route, tenant and optionally user, in time windows inside the service.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
metrics: {}
```

It is not enabled by default: turn it on with `metrics: {}` or `QS_METRICS_ENABLED=true`, and off with `metrics: false` or `QS_METRICS_ENABLED=false`.

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `metrics.window` | `duration` | `"1m"` | `QS_METRICS_WINDOW` | no | The length of each usage window. |
| `metrics.retention` | `duration` | `"2h"` | `QS_METRICS_RETENTION` | no | How long minute windows are kept before they are rolled up. |
| `metrics.rollup.window` | `duration` | `"1h"` | `QS_METRICS_ROLLUP_WINDOW` | no | The length of each rollup window. |
| `metrics.rollup.retention` | `duration` | `"7d"` | `QS_METRICS_ROLLUP_RETENTION` | no | How long rollup windows are kept. |
| `metrics.by` | `("route" \| "tenant" \| "user")[]` | `["route","tenant"]` | `QS_METRICS_BY` | no | The dimensions of each series: the route as its method and pattern (GET /posts), and the tenant and user ids (- when absent). |
| `metrics.maxSeries` | `integer` | `10000` | `QS_METRICS_MAX_SERIES` | no | The most series per window and worker; further ones are counted in one series whose dimensions are all other. |
| `metrics.exclude` | `string[]` | `["/health/*","/_metrics","/docs"]` | `QS_METRICS_EXCLUDE` | no | Route patterns that are not counted; a pattern ending in /* covers every route under it. |
| `metrics.enabled` | `boolean` | `true` | `QS_METRICS_ENABLED` | no | Turns the feature off when false. |

## Feature API

Other features reach it with `ctx.feature("metrics")` in their setup, listing `metrics` in `requires` or `after`.

### `query`

```ts
query(options?: MetricsQuery): Promise<MetricsResult>;
```

The usage series of the windows in a range, merged and grouped by the chosen dimensions, with `requests`, `errors`,
`clientErrors`, `p50`, `p95`, `p99` and `max` (milliseconds), plus totals.
