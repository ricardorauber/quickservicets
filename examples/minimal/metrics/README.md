# metrics

The smallest project that shows the `metrics` native: every request of the tenants `acme` and `globex` is counted in one-minute windows per route and tenant, with its errors and its latency (p50, p95, p99); closed windows go to the `MetricWindow` table of the SQLite database, so every worker and replica reports the whole service. `GET /posts/feed` fails one time in five so there are errors to count, and `GET /internal/ping` is left out.

```bash
bun run test
```

The usage metrics guide (`docs/src/content/docs/guides/usage-metrics.md`, on the site at `/guides/usage-metrics/`) explains every piece.

## Level 0: enable

Turn the native on; every request is counted, and `GET /_metrics` answers from loopback and private addresses:

```ts
export default defineConfig({ database: sqliteAdapter({ path: "data.db" }), metrics: {} });
```

```bash
curl localhost:3000/_metrics
curl "localhost:3000/_metrics?format=prometheus"
```

## Level 1: options and environment

`window`, `retention`, `rollup`, `by`, `maxSeries`, `exclude`, `store`, `path` and `access` shape the windows, the series and the route; `store: "database"` keeps closed windows in the project's database (run `quickservicets migration add` after enabling it), and every option has a `QS_*` variable:

```ts
metrics: { store: "database", by: ["route", "tenant"], access: { token: env.METRICS_TOKEN } }
```

```bash
QS_METRICS_BY=route QS_METRICS_ACCESS_TOKEN=s3cret bun .generated/server.ts
```

## Level 2: tags

`@metrics off` leaves an endpoint or an entity's routes out, and `@metrics by=route` counts them without the tenant and user dimensions:

```ts
// endpoints/internal/ping/get.ts
/**
 * @metrics off
 * @tenancy off
 */
export default () => ({ pong: true });
```

## Level 3: per request

`record` decides after each response whether it is counted, like leaving out synthetic checks:

```ts
metrics: { record: ({ req }) => !req?.headers.has("x-synthetic") }
```

## Level 4: hooks and events

`beforeRecord` may change an observation (group routes) or return `null` to skip it, and `onWindowClosed` receives each closed window of the worker, for pushing it elsewhere:

```ts
metrics: {
  beforeRecord: [(observation) => (observation?.route?.startsWith("/reports/") ? { ...observation, route: "/reports/*" } : observation)],
  onWindowClosed: [({ windowStart, series }) => console.log(JSON.stringify({ windowStart, series: series.length }))],
}
```

## Level 5: override files

A project endpoint at the route's path replaces it, and `queryMetrics` reads the same series:

```ts
// endpoints/_metrics/get.ts
import { queryMetrics } from "@quickservicets/core";

export default async () => {
  const usage = await queryMetrics({ last: "1h", sort: "p95" });
  return { busiest: usage.series.slice(0, 5), totals: usage.totals };
};
```

## Level 6: replace the implementation

A `MetricsStore` with `write`, `read` and `prune` replaces the memory and database stores, like one appending JSON lines:

```ts
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { MetricsStore, StoredWindow } from "@quickservicets/core";

const lines = (): StoredWindow[] => (existsSync("metrics.jsonl") ? readFileSync("metrics.jsonl", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const store: MetricsStore = {
  async write(windows) {
    for (const window of windows) appendFileSync("metrics.jsonl", `${JSON.stringify(window)}\n`);
  },
  async read({ from, to }) {
    // The last line of each instance, resolution and start wins.
    const latest = new Map(lines().map((window) => [`${window.instance} ${window.resolution} ${window.windowStart}`, { ...window, windowStart: new Date(window.windowStart) }]));
    return [...latest.values()].filter((window) => window.windowStart >= from && window.windowStart < to);
  },
  async prune({ resolution, before }) {
    const all = lines();
    const kept = all.filter((window) => window.resolution !== resolution || new Date(window.windowStart) >= before);
    writeFileSync("metrics.jsonl", kept.map((window) => JSON.stringify(window)).join("\n") + (kept.length > 0 ? "\n" : ""));
    return all.length - kept.length;
  },
};

export default defineConfig({ database: sqliteAdapter({ path: "data.db" }), metrics: { store } });
```

## Level 7: eject

Copy the native into the project, where it replaces the built-in one:

```bash
bunx quickservicets eject metrics
```
