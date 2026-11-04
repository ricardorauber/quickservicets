---
title: Serverless connections
description: Size database connections for the platform the service runs on, so many function instances never exhaust the database while servers keep their pools.
sidebar:
  order: 65
---

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

## See also

- [Deploy targets](/guides/deploy-targets/): the platforms and their function mode.
- [connections reference](/reference/features/connections/): every option with its variable.
