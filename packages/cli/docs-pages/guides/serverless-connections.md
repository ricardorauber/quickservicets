# Serverless connections

> Size database connections for the platform the service runs on, so many function instances never exhaust the database while servers keep their pools.

A database grants a fixed number of connections. A long-running server opens a pool and keeps it; a function platform may run hundreds of short-lived instances at once, each with its own pool. The `connections` native sizes the pools for the platform, and it is enabled by default.

## The connection arithmetic

The connections a service may open at once are `max × server.workers × instances`: the pool size of each worker, times the workers of each instance, times the instances running at once. With `budget` (the connections the database grants this service) and `instances` (the most instances expected at once), startup warns when the product can exceed the budget:

```ts
export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
  connections: { max: 5, instances: 20, budget: 100 },
});
```

```text
connections may reach 200, above connections.budget 100; lower connections.max or use a connection proxy
```

## Server and serverless modes

`mode` is `auto` by default: `serverless` on the `lambda` and `azure-functions` [deploy targets](/guides/deploy-targets/), `server` otherwise; `server` and `serverless` force one.

- In `server` mode with no option set, the adapters keep exactly their own pools (`postgresAdapter` opens up to 10 connections, divided across the workers), so existing deployments are unchanged.
- In `serverless` mode, unset options default to `max` 2, `idleTimeout` `30s`, `maxLifetime` `15m`, `connectTimeout` `5s` and `lazy` true.

Each option has its variable (`QS_CONNECTIONS_MAX`, `QS_CONNECTIONS_MODE`…). The PostgreSQL adapter passes them to `Bun.SQL`, and the MongoDB adapter to `maxPoolSize`, `maxIdleTimeMS` and `connectTimeoutMS`, replacing its client every `maxLifetime`; the memory and SQLite adapters have no pool. `connections.databases.<name>` overrides the settings for one named database, and startup logs each database's pool in `connections.pools`.

## Lazy connections and frozen instances

With `lazy`, an adapter opens its first connection on its first query instead of at startup, so an invocation that touches no database opens none. A function instance frozen between invocations may find its idle connection closed by the database; a statement that fails before it was sent is retried once on a new connection and logged as `connections.reconnected`, while a statement that may have reached the database is never retried.

## Connection proxies

A connection proxy (PgBouncer in transaction mode, Amazon RDS Proxy) lets many instances share a few database connections: each transaction borrows a server connection and returns it. What lives on a session does not survive that, so `proxy` tells the service which one is in front of PostgreSQL:

```ts
export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
  connections: { proxy: "pgbouncer", direct: secret("env://DATABASE_DIRECT_URL") },
});
```

- With `proxy: "pgbouncer"` or `"rds-proxy"`, the PostgreSQL adapter uses no server-side prepared statements and sends no session `SET`, so a statement never pins or breaks a pooled connection.
- `rds-proxy` also requires TLS; a database URL with `sslmode=disable` fails startup with `RDS Proxy needs TLS; add sslmode=require to the database URL`.
- `direct` is a connection that bypasses the proxy. `quickservicets migrate` uses it, since migrations hold locks and run DDL across statements, and so do the features that keep a session of their own, like the PostgreSQL transport of `realtime.websockets`, whose `LISTEN` does not work through a proxy. Without `direct`, such a feature fails startup:

```text
realtime needs a direct connection because LISTEN does not work through PgBouncer; set connections.direct
```

A feature of the project that keeps a session declares `needsSession: true` (or a function of its options) in `defineFeature`, and gets the same check.

## Checking a database

`quickservicets db check` connects with the project's config and prints what the database and the pools look like, without any password:

```text
database: PostgreSQL 17.11
max_connections: 100
connections: 7 open
pool: prepare false
proxy: pgbouncer (prepared statements off)
direct: works
```

It prints one `problem:` line per feature the proxy cannot carry, with its fix, and exits 1 when a check fails, so it can run before a deploy.

## SQL executors

The PostgreSQL adapter builds its statements once and sends each one through a `SqlExecutor`, so an HTTP driver or a managed data API can carry every query, aggregate, migration and `ping` of the adapter. Without `executor`, the built-in one sends them over `Bun.SQL`, as before:

```ts
interface SqlExecutor {
  readonly name: string;
  readonly capabilities: { interactiveTransactions: boolean; listen: boolean; preparedStatements: boolean };
  query(text: string, params: readonly unknown[], options?: { signal?: AbortSignal }): Promise<Record<string, unknown>[]>;
  transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

```ts
export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL!, executor: myHttpExecutor(process.env.DATABASE_URL!) }),
});
```

- `query` runs one statement with `$1`-style parameters and resolves its rows as objects; an aborted `signal` rejects it with an `AbortError`.
- Errors carry the PostgreSQL error code (SQLSTATE) as `code` and the constraint as `constraint`, so a `23505` becomes a `UniqueViolationError` on the right field, as with the built-in executor.
- A feature that needs a capability the executor lacks fails startup, like `realtime needs listen, which the http executor does not support` for the PostgreSQL socket transport; `transaction(fn)` on an executor without `interactiveTransactions` fails with `transaction needs interactiveTransactions, which the http executor does not support`. A project feature declares what it needs with `sqlCapabilities: ["listen"]` in `defineFeature`.
- `bunSqlExecutor(new Bun.SQL(url))` is the built-in executor, for wrapping it (to record or time statements).

`runSqlExecutorContract(create, { name, variable })` from `@quickservicets/core/testing` registers the tests every executor must pass: the adapter contract on `postgresAdapter({ executor: create(url) })`, type round trips (dates, JSON, UUIDs, numerics, arrays, nulls), transactions with rollback, unique violations and abort signals. They run when the variable (default `TEST_POSTGRES_URL`) is set, and are one named skipped test otherwise; they drop and recreate the `public` schema of that database, so point the variable at a test database:

```ts
import { runSqlExecutorContract } from "@quickservicets/core/testing";

runSqlExecutorContract((url) => myHttpExecutor(url), { name: "http", variable: "TEST_HTTP_SQL_URL" });
```

## See also

- [Deploy targets](/guides/deploy-targets/): the platforms and their function mode.
- [connections reference](/reference/features/connections/): every option with its variable.
