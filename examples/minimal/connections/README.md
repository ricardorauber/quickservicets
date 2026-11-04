# connections

The smallest project that shows the `connections` native: a `Post` entity on PostgreSQL, whose database grants the service 100 connections shared by up to 10 instances at once.

```bash
bun run build          # a server: the adapter keeps its own pool
bun run build:lambda   # a function: two lazy connections per instance
bun run test
```

`bun run test` checks the pool each deploy target gets through a memory adapter spy, serves the posts in memory, and runs the CRUD flow through PgBouncer in transaction mode with `proxy: "pgbouncer"` and the migrations on the direct connection, in throwaway containers; without Docker that test is skipped by name.

Pools belong to the process, not to entities, routes or requests, so tags, per-request functions and override files do not apply.

## Level 0: enable

The native is enabled by default. On a server target the adapter keeps its own pool; building for `lambda` or `azure-functions` gives each instance `max` 2, `idleTimeout` `30s`, `maxLifetime` `15m`, `connectTimeout` `5s` and `lazy` connections:

```bash
bun run quickservicets build --target lambda
```

## Level 1: options and environment

Every option has a `QS_CONNECTIONS_*` variable, like `QS_CONNECTIONS_MAX`; with `budget` and `instances`, startup warns when `max × workers × instances` can exceed the budget:

```ts
connections: { max: 5, budget: 100, instances: 10 },
```

```bash
QS_CONNECTIONS_MAX=3 bun run dev
```

## Level 2: tags

Not applicable: pools belong to the process, not to entities, fields or routes.

## Level 3: per request

Not applicable: pools belong to the process, not to requests.

## Level 4: hooks and events

`onConnect` runs each time a pooled connection opens, here logging how long it took; `onConnectionError` sees every failed connection:

```ts
connections: {
  budget: 100,
  instances: 10,
  onConnect: ({ database, durationMs }) => console.log(`connected to ${database} in ${durationMs} ms`),
  onConnectionError: ({ error, retried }) => console.warn("connection failed", { retried, error }),
},
```

## Level 5: override files

Not applicable: pools belong to the process, so there is no file to override.

## Level 6: replace the implementation

The PostgreSQL adapter sends every statement through a `SqlExecutor`; a driver for Neon's serverless HTTP API or for the RDS Data API is one, passed as `executor`. Here one that times each statement over the built-in executor:

```ts
import { bunSqlExecutor, defineConfig, postgresAdapter, type SqlExecutor } from "@quickservicets/core";

const timed = (inner: SqlExecutor): SqlExecutor => ({
  ...inner,
  name: "timed",
  async query(text, params, options) {
    const started = performance.now();
    try {
      return await inner.query(text, params, options);
    } finally {
      console.log(`${(performance.now() - started).toFixed(1)} ms ${text.slice(0, 40)}`);
    }
  },
  transaction: (fn) => inner.transaction((tx) => fn(timed(tx))),
});

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL!, executor: timed(bunSqlExecutor(new Bun.SQL(process.env.DATABASE_URL!))) }),
});
```

## Level 7: eject

```bash
bun run quickservicets eject connections
```

`features/connections/` then replaces the native, and the example's tests keep passing.
