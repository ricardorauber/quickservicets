# tenancy

The smallest project that shows the `tenancy` native with both strategies: tenant `acme` (free plan) keeps its projects in a schema of `data.db`, tenant `globex` (enterprise plan) in a SQLite file of its own, and every request names its tenant in the `x-tenant-id` header. `Plan` is shared by every tenant, `GET /plans` answers without a tenant, the `notify` consumer and the `digest` job run for each tenant in its own data.

```bash
bun run build && bun run migrate && bun run seed && bun run start
curl -X POST localhost:3000/projects -H "x-tenant-id: acme" -H "content-type: application/json" -d '{"name":"Rocket"}'
bun run test
```

## Level 0: enable

One key turns it on: tenants come from the `Tenant` table, each in a schema of the service's database, resolved from the `x-tenant-id` header.

```ts
tenancy: {}
```

```bash
bun run quickservicets tenants create acme --plan free
```

## Level 1: options and environment

`from` lists where the tenant id comes from, in order; every option has its variable.

```ts
tenancy: { from: ["subdomain", "header"], domain: "app.example.com" }
```

```bash
QS_TENANCY_HEADER=x-org bun run start
```

## Level 2: tags

`@tenancy shared` keeps an entity's records shared by every tenant, and `@tenancy off` lets an endpoint answer without one:

```ts
/**
 * A plan every tenant can choose; its records are shared by all of them.
 * @tenancy shared
 */
export type Plan = {
  name: string;
  price: number;
};
```

```ts
/**
 * The plans, for the sign-up page: answered without a tenant.
 * @tenancy off
 */
export default (repos: Repositories) => repos.plans.list({ where: [], sort: [{ field: "price", direction: "asc" }], limit: 100, offset: 0 });
```

## Level 3: per request

The strategy is a function of the tenant, called once per tenant: enterprise tenants get a database of their own.

```ts
tenancy: {
  strategy: ({ tenant }) => (tenant?.plan === "enterprise" ? "database" : "schema"),
  connection: "data/tenant_{tenant}.db",
}
```

## Level 4: hooks and events

`beforeResolve` can change or drop the id the sources found, like the `www` subdomain:

```ts
tenancy: { from: ["subdomain"], domain: "app.example.com", beforeResolve: ({ id }) => (id === "www" ? null : undefined) }
```

## Level 5: override files

A project `entities/Tenant.ts` replaces the native's table; it keeps the native's fields and may add its own:

```ts
export type Tenant = {
  key: string;
  plan?: string;
  strategy?: "schema" | "database";
  schema?: string;
  connection?: string;
  status: "active" | "suspended";
  attributes?: { region?: string };
  billingEmail?: string;
};
```

## Level 6: replace the implementation

A `directory` provider replaces where tenants are looked up, here a JSON file, and keeps the cache:

```ts
import tenants from "./tenants.json";

tenancy: {
  directory: {
    find: async (id) => tenants.find((tenant) => tenant.id === id),
    list: async function* () {
      yield* tenants;
    },
  },
}
```

## Level 7: eject

```bash
quickservicets eject tenancy
```
