# Multi-tenancy

> Serve many tenants from one service, each request resolved to its tenant, with each tenant's data in a schema or a database of its own, shared entities, per-tenant migrations, background work and an isolation test suite.

A software-as-a-service product serves many customers, the tenants, from one deployment: each sees only its own projects, invoices and users, while plans and the product catalog are shared. The `tenancy` native makes the request the unit of tenancy: every request is resolved to one tenant, and everything it does, from its hooks and handler to the queue messages, events and jobs it starts, reads and writes that tenant's data only. The options, variables, tags, hooks, commands and error codes are listed on the [tenancy reference page](/reference/features/tenancy/); the [multi-tenant recipe](/recipes/multi-tenant/) keeps the simpler alternative of one deployment per tenant.

The samples come from the example project `examples/minimal/tenancy`, where tenant `acme` keeps its data in a schema of `data.db` and tenant `globex`, on the enterprise plan, in a SQLite file of its own.

```ts title="quickservicets.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: "data.db" }),
  // Tenants on the enterprise plan get a database of their own; the others a schema of data.db.
  tenancy: {
    strategy: ({ tenant }) => (tenant?.plan === "enterprise" ? "database" : "schema"),
    connection: "data/tenant_{tenant}.db",
  },
  queues: {},
});
```

## Tenants and the request

A tenant has an id (lowercase letters, digits and dashes, at most 63 characters), a status (`active` or `suspended`), an optional plan and attributes, and, for the database strategy, a connection. Each request is resolved to exactly one tenant before any hook runs; `req.tenant` then holds `{ id, plan, attributes }` (never the connection), and the request runs in the tenant's database scope. A request without a tenant answers `400 TENANT_REQUIRED`, an unknown one `404 TENANT_NOT_FOUND` and a suspended one `403 TENANT_SUSPENDED`.

## Resolution sources and their order

`tenancy.from` lists where the id comes from, tried in order, the first that yields an id winning:

- `header`: the `x-tenant-id` header (`tenancy.header`).
- `subdomain`: the single label in front of `tenancy.domain`, so `acme.app.example.com` is `acme`; `x-forwarded-host` counts only from proxies trusted by `security.proxy.trust`.
- `path`: a prefix like `/t/[tenant]` (`tenancy.path`), removed before routing, so `/t/acme/projects` is routed as `/projects` and the `Location` of a created record keeps the prefix.
- `auth`: the tenant an authentication middleware set from the credentials; any other source that names a different tenant answers `403 TENANT_MISMATCH`.
- `function`: `tenancy.resolve`, a function of the request.

An id outside the rule answers `400 INVALID_TENANT` without echoing it. `@tenancy off` on an endpoint, the API docs, the health routes and the paths a feature exempts with `ctx.feature("tenancy").exempt("/public/*")` need no tenant; `@tenancy required=false` makes one optional.

## The directory and its cache

`tenancy.source` says where tenants are looked up:

- `database` (the default): the internal `Tenant` table of the service's database, managed with the `tenants` commands or `provisionTenant`.
- `config`: `tenancy.tenants`, by id, with `QS_TENANCY_TENANTS_<ID>_PLAN` and `QS_TENANCY_TENANTS_<ID>_STATUS`.
- `service`: another service through the HTTP client, `GET /tenants/:id` and paged `GET /tenants`.

Each worker caches lookups for `tenancy.cache.ttl` (5 minutes), unknown ids for `negativeTtl` (30 seconds), with one lookup in flight per id; when the directory fails, an entry younger than `staleTtl` (1 hour) is still used, and without one the request answers `503 TENANT_DIRECTORY_UNAVAILABLE`. A write to `Tenant` through the worker's repositories refreshes its entry at once.

## Shared and tenant entities

Every entity holds tenant data unless it is shared: entities with an explicit schema, the core's own tables and entities tagged `@tenancy shared`. A tenant entity cannot reference a shared one, nor the reverse, because a tenant may live in another database: the build fails and asks for a string field holding the id.

```ts title="entities/Plan.ts"
/**
 * A plan every tenant can choose; its records are shared by all of them.
 * @tenancy shared
 */
export type Plan = {
  name: string;
  price: number;
};
```

```ts title="endpoints/plans/get.ts"
import type { Repositories } from "@quickservicets/core";

/**
 * The plans, for the sign-up page: answered without a tenant.
 * @tenancy off
 */
export default (repos: Repositories) => repos.plans.list({ where: [], sort: [{ field: "price", direction: "asc" }], limit: 100, offset: 0 });
```

Code that runs without a tenant (an exempt endpoint, a plain job) reads shared entities freely, and a call to a tenant entity throws `TenantRequiredError`, answered as `400 TENANT_REQUIRED`.

## Two strategies

| | Schema per tenant | Database per tenant |
| --- | --- | --- |
| Where | A schema of the service's database (`tenancy.schema`, `tenant-{tenant}`); on SQLite, tables prefixed `tenant_acme__` | A database of its own, from its connection |
| Connections | The service's pool, shared by every tenant | A small pool per tenant and worker |
| Isolation | Separate tables, one server | Separate databases, possibly separate servers |
| Cost | One database for every tenant | One database per tenant |
| Limits | The server's limits on schemas and tables | Open pools per worker (`tenancy.pools.max`) |
| Transactions | Include the shared tables | Shared rows are staged and relayed |

Choose schemas by default: they are cheap, and a request of one tenant never sees another's tables. Give a database of its own to tenants that need stronger isolation, a region, their own backups or their own server, usually on bigger plans: `tenancy.strategy` decides per tenant, below a strategy set in the tenant's own entry.

## Pools and their limits

The first request of a database tenant opens its pool (`pools.connections` connections, at most `pools.connectTimeout` to connect); each worker keeps at most `pools.max` pools, closes the least recently used idle one to make room, answers `503 Too many tenant databases are busy` when every pool is in use, and closes a pool unused for `pools.idle`. A database that cannot be reached answers `503 Tenant database is unavailable`, and the next attempt waits 10 seconds. `ctx.feature("tenancy").stats()` reports the pools of the worker.

## Connections

The connection of a database tenant is, in order, its own `connection` in the directory, `tenancy.connection` (a template with `{tenant}`, like the example's `data/tenant_{tenant}.db`, or a function of the tenant), then `tenancy.connectionService` (`GET /tenants/:id/connection`). Resolved connections are cached for the service's `ttl` or `connectionCache.ttl`; refused credentials resolve once more, and a changed connection moves new requests to a new pool while the old one finishes. Connections are secrets: they never appear in logs, answers or `stats()`.

## Migrations and the tenants commands

With tenancy, `quickservicets migration add` marks the statements of shared tables with `{ shared: true }`. `quickservicets migrate` runs only those in the service's database, `quickservicets migrate --tenant acme` runs the others in one tenant's schema or database, and `quickservicets migrate --all-tenants` does the service's database and then every tenant (`--concurrency`, `--continue-on-error`).

```bash
bun run quickservicets migrate --all-tenants
bun run quickservicets tenants create acme --plan free
bun run quickservicets tenants list --pending
bun run quickservicets tenants suspend acme
bun run quickservicets tenants resume acme
```

`tenants create` adds the tenant as suspended, migrates it and makes it active; from code, `provisionTenant({ id, plan })` does the same, for a sign-up endpoint, and `migrateTenant(id)` migrates one tenant. The example's seed script creates its tenants:

```ts title="scripts/seed.ts"
import { mkdirSync } from "node:fs";

/**
 * Creates the example's tenants: acme on the free plan (a schema of data.db) and globex on the enterprise plan (its
 * own file in data/). Run it after `quickservicets migrate`, with `bun run seed`.
 */
mkdirSync("data", { recursive: true });
const tenants: [id: string, plan: string][] = [
  ["acme", "free"],
  ["globex", "enterprise"],
];
for (const [id, plan] of tenants) {
  const result = Bun.spawnSync(["bun", "x", "quickservicets", "tenants", "create", id, "--plan", plan], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
```

## Background work

Work started for a tenant runs for that tenant: a queue message stores the tenant of the request that added it and its consumer runs in that tenant's scope; write events carry `actor.tenant`, and their listeners and outbox deliveries run in the event's tenant; change streams only see their tenant's events. `runForTenant(id, fn)` runs any code for a tenant, and a job with `tenants: "each"` runs once per active tenant.

```ts title="queues/notify.ts"
import { queue } from "@quickservicets/core";

/** Writes a notification about a project, in the tenant the message was added for. */
export default queue<{ projectId: string }>(async ({ payload, repos, tenant }) => {
  const project = await repos.projects.findById(payload.projectId);
  await repos.notifications.create({ message: `${tenant?.id}: ${project?.name ?? "unknown project"} changed` });
});
```

```ts title="jobs/digest.ts"
import { job } from "@quickservicets/core";

/** Every day, for each active tenant, records how many projects it has. */
export default job(
  "@daily",
  async ({ repos }) => {
    await repos.digests.create({ projects: await repos.projects.count() });
  },
  { tenants: "each" },
);
```

## The relay and its delivery

A tenant with a database of its own cannot write the shared queue and outbox tables in its transaction, so those rows are staged in its own database (`qs_staged_*` tables) and relayed to the shared tables right after the commit, when its pool opens, every `relay.interval` and by the daily `tenancy/relay` job. Delivery is at least once, delayed by up to `relay.interval` after a crash, so consumers must be idempotent.

## Logs and reports

Every log entry written for a tenant carries `tenant`: the request log entry and every entry of the code that runs in a tenant scope. Error reports outside requests take the tenant of their scope, and calls to services that propagate the tenant send `x-tenant-id`. The native logs `tenancy.resolved`, `tenancy.unknown`, `tenancy.suspended` and its pool, connection and relay entries, never a connection or a rejected id. Other features read `currentTenant()`.

## Isolation testing

`runTenantIsolationSuite` from `@quickservicets/core/testing` checks that one tenant never sees or changes another's data: reads, writes, references, cascades, unique values, resolution tricks, background work and caches, as one named test each. The example runs it on its own entities:

```ts
runTenantIsolationSuite({ adapter: "memory", strategy: "schema", name: "example", models: parseProjectEntities(root, config.features), entities: ["Project"] });
```

## Customization

Every level of the [native features](/guides/features/) applies:

1. **Enable**: `tenancy: {}` and `quickservicets tenants create`.
2. **Options and environment**: `from`, `header`, `domain`, `strategy`, `schema`, `pools`, every one with its `QS_TENANCY_*` variable.
3. **Tags**: `@tenancy shared` on entities, `@tenancy off` and `@tenancy required=false` on endpoints.
4. **Per request**: `strategy` and `connection` as functions of the tenant, `resolve` as a function of the request.
5. **Hooks and events**: `beforeResolve` (another id, `null` for none, or a throw), `afterResolve`, `onUnknownTenant`, `onPoolOpen`, `onPoolClose`.
6. **Override files**: a project `entities/Tenant.ts` with extra fields, a project `jobs/tenancy/relay.ts`.
7. **Replace the implementation**: a `directory` provider, a `resolver`, or `setDirectory` from a feature.
8. **Eject**: `quickservicets eject tenancy`.

## Deleting a tenant's data

No command deletes a tenant: the obligations around it (erasure duties, contractual retention, backups) are the operator's. Delete one by hand, after a backup:

1. Back up its schema or database.
2. Suspend it: `quickservicets tenants suspend acme`.
3. Drop its data: `DROP SCHEMA tenant_acme CASCADE` on PostgreSQL, the `tenant_acme__*` tables on SQLite, `db.dropDatabase()` of `tenant_acme` on MongoDB, or the tenant's own database.
4. Delete its rows in the shared tables that name it (queue messages, outbox rows), then its `Tenant` row.
