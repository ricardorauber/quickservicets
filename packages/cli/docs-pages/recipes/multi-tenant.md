# Multi-tenant schemas

> Give each deployment its own database schema with DATABASE_SCHEMA, and group entities into explicit schemas with folders or @schema.

To serve many tenants from one running service, each request resolved to its tenant, use the [Multi-tenancy guide](/guides/multi-tenancy/) and the `tenancy` native. This recipe covers the simpler alternative: one deployment per tenant, each with its own default schema.

You run the same API for several customers and want each one's data apart, in the same database server, without a second build. Or you want some entities, like accounts, in a schema of their own. QuickService.ts has two tools for this:

| | Default schema | Explicit schema |
| --- | --- | --- |
| Set with | `DATABASE_SCHEMA`, or `schema` in the config | A folder in `entities/`, or `@schema` |
| Decided | When the server or `migrate` starts | At build time |
| Applies to | Every entity without an explicit schema | That entity only |
| Routes and repositories | Unchanged: `/users`, `repos.users` | Prefixed: `/auth/users`, `repos.auth.users` |

## One schema per tenant: `DATABASE_SCHEMA`

Write the entities as usual:

```ts title="entities/Project.ts"
export type Project = {
  name: string;
};
```

Build and create the migration once:

```bash
bun run quickservicets migration add Initial
```

Then give each deployment its own `DATABASE_SCHEMA`, for `migrate` and for the server:

```bash
DATABASE_SCHEMA=tenant-a bun run quickservicets migrate
# Applied 20261016223339_Initial
DATABASE_SCHEMA=tenant-b bun run quickservicets migrate
# Applied 20261016223339_Initial

DATABASE_SCHEMA=tenant-a PORT=3001 bun run start
DATABASE_SCHEMA=tenant-b PORT=3002 bun run start
```

Both servers expose the same routes, and each one only sees its own records:

```bash
curl -X POST localhost:3001/projects -d '{"name":"Apollo"}'
# {"id":"01a146d9-8401-773d-bb02-bedd394aaf98","createdAt":"2026-10-16T22:33:42.658Z","updatedAt":"2026-10-16T22:33:42.658Z","name":"Apollo"} (201)
curl localhost:3001/projects
# {"data":[{"id":"01a146d9-8401-773d-bb02-bedd394aaf98","createdAt":"2026-10-16T22:33:42.658Z","updatedAt":"2026-10-16T22:33:42.658Z","name":"Apollo"}],"total":1,"limit":20,"offset":0}
curl localhost:3002/projects
# {"data":[],"total":0,"limit":20,"offset":0}
```

The default schema is resolved when the process starts, never written into `.generated/` or `migrations/`, so one build and one set of migration files serve every tenant. In a deployment, set `DATABASE_SCHEMA` like any other environment variable, or in the project's `.env`, which Bun loads.

To set a default for every environment, put `schema` in the config; `DATABASE_SCHEMA` still wins when it is set (an empty value counts as unset):

```ts title="quickservicets.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  schema: "app",
});
```

The resolved default is `DATABASE_SCHEMA`, otherwise `schema`, otherwise none, which means the database's own default (`public` on PostgreSQL, unprefixed tables on SQLite).

### Where each database puts it

A hyphen in the name becomes an underscore in the database, so `tenant-a` is stored as `tenant_a`.

| Database | `DATABASE_SCHEMA=tenant-a` | No default schema |
| --- | --- | --- |
| PostgreSQL | Schema `tenant_a` (created if missing), used through `search_path`: table `tenant_a.projects` | `public.projects` |
| SQLite | Table name prefix: `tenant_a__projects` | `projects` |
| MongoDB | Database `tenant_a` | The database of the adapter config (`DATABASE_NAME`) |
| Memory | No effect: each process has its own records | — |

Each tenant also has its own migration history (on SQLite, `tenant_a____quickservicets_migrations`), so migrating one tenant never marks a migration as applied for another. On SQLite, the migration files hold a placeholder for default-schema tables that `migrate` replaces:

```sql
CREATE TABLE `{{default_schema}}projects` (...)
```

## Entities in their own schema: folders and `@schema`

A file in a folder of `entities/` belongs to the schema named after the folder. Here `entities/auth/User.ts` lives in schema `auth`, next to a default-schema `User` that references it:

```ts title="entities/auth/User.ts"
export type User = {
  /** @unique */
  email: string;
};
```

```ts title="entities/User.ts"
import type { User as Account } from "./auth/User.ts";

export type User = {
  /** @unique */
  email: string;
  account?: Account;
};
```

`@schema` sets the schema without a folder, and wins over the folder when both are present:

```ts title="entities/Invoice.ts"
/** @schema billing-eu */
export type Invoice = {
  number: string;
};
```

Schema-bound entities get the schema as a prefix of their routes:

```bash
curl -X POST localhost:3000/auth/users -d '{"email":"ana@x.co"}'
# {"id":"01a146d8-6bab-70b9-99e3-c70fac60daf0","createdAt":"2026-10-16T22:32:30.892Z","updatedAt":"2026-10-16T22:32:30.892Z","email":"ana@x.co"} (201)
curl -X POST localhost:3000/users -d '{"email":"ana@x.co","account":"01a146d8-6bab-70b9-99e3-c70fac60daf0"}'
# {"id":"01a146d8-6bdd-704a-9110-4ea6f9e5db31","createdAt":"2026-10-16T22:32:30.941Z","updatedAt":"2026-10-16T22:32:30.941Z","email":"ana@x.co","account":"01a146d8-6bab-70b9-99e3-c70fac60daf0"} (201)
curl -X POST localhost:3000/billing-eu/invoices -d '{"number":"2026-001"}'
# {"id":"01a146d8-6c01-740c-8aab-4f75236469dd","createdAt":"2026-10-16T22:32:30.977Z","updatedAt":"2026-10-16T22:32:30.977Z","number":"2026-001"} (201)
```

Both `users` collections accept `ana@x.co`, because each schema has its own tables and its own unique indexes. References work across schemas, including `@onDelete`:

```bash
curl -X DELETE localhost:3000/auth/users/01a146d8-6bab-70b9-99e3-c70fac60daf0
# {"error":{"code":"CONFLICT","message":"Cannot delete: referenced by users"}} (409)
```

### Repositories and types

In endpoints and hooks, a schema-bound repository sits under the schema's key, the schema name in camelCase: `repos.auth.users`, `repos.billingEu.invoices`. When two schemas have an entity with the same type name, the generated type of the schema-bound one gets the schema as a prefix, so `entities/auth/User.ts` becomes `AuthUser` in `.generated/types.ts`.

`endpoints/accounts/get.ts`, serving `GET /accounts?email=...`:

```ts title="endpoints/accounts/get.ts"
import { HttpError, type Endpoint } from "@quickservicets/core";

/** @summary Find an account by email */
const handler: Endpoint = async (repos, req) => {
  const email = req.query.get("email") ?? "";
  const account = await repos.auth.users.findOne([{ field: "email", op: "eq", value: email }]);
  if (!account) throw new HttpError(404, "Account not found");
  return account;
};

export default handler;
```

```bash
curl "localhost:3000/accounts?email=ana@x.co"
# {"id":"01a146d8-6bab-70b9-99e3-c70fac60daf0","createdAt":"2026-10-16T22:32:30.892Z","updatedAt":"2026-10-16T22:32:30.892Z","email":"ana@x.co"}
curl "localhost:3000/accounts?email=bob@x.co"
# {"error":{"code":"NOT_FOUND","message":"Account not found"}} (404)
```

<details>
<summary>The part of <code>.generated/types.ts</code> that types <code>repos.auth</code></summary>

```ts title=".generated/types.ts"
// Generated by quickservicets build. Do not edit. (Excerpt.)
import type { Repository } from "@quickservicets/core";

export type AuthUser = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
};

export type AuthUserCreate = {
  email: string;
};

export type AuthUserUpdate = {
  email?: string;
};

export type AuthUserReferences = Record<never, never>;

export interface GeneratedRepositories {
  auth: {
    users: Repository<AuthUser, AuthUserReferences, AuthUserCreate, AuthUserUpdate>;
  };
}

declare module "@quickservicets/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

</details>

To replace a generated route of a schema-bound entity, put the endpoint at the prefixed path: `endpoints/auth/users/[id]/get.ts` replaces `GET /auth/users/:id`. In the API docs, the entity's tag is `auth/users`.

### Where each database puts it

| Database | `auth/users` |
| --- | --- |
| PostgreSQL | Table `users` in schema `auth`; the migration starts with `CREATE SCHEMA IF NOT EXISTS "auth"` |
| SQLite | Table `auth__users` |
| MongoDB | Collection `users` in database `auth` |
| Memory | Its own namespace, apart from `users` |

Index names include the schema so they stay unique, such as `auth_users_email_uq` next to `users_email_uq`. Files of a schema-bound file entity are stored under keys that start with the schema (`auth/...`).

## Migrations

One `migration add` covers every schema. On SQLite, the migration for the entities above runs these statements (columns left out):

```sql
CREATE TABLE `billing_eu__invoices` (...);
CREATE TABLE `{{default_schema}}users` (..., FOREIGN KEY (`account`) REFERENCES `auth__users`(`id`) ON UPDATE no action ON DELETE restrict);
CREATE UNIQUE INDEX `{{default_schema}}users_email_uq` ON `{{default_schema}}users` (`email`);
CREATE TABLE `auth__users` (...);
CREATE UNIQUE INDEX `auth_users_email_uq` ON `auth__users` (`email`);
```

Explicit-schema tables have fixed names; only default-schema tables follow `DATABASE_SCHEMA`.

On MongoDB, a migration reaches each schema's database through `ctx.db`: `ctx.db("auth")` is the `auth` database and `ctx.db()` the default one, which is the tenant's database when `DATABASE_SCHEMA` is set.

```ts title="migrations/20261016120000_VerifyAccounts.ts"
import type { MongoMigrationContext } from "@quickservicets/core";

export async function up(ctx: MongoMigrationContext): Promise<void> {
  await ctx.db("auth").collection("users").updateMany({}, { $set: { verified: false } });
}

export async function down(ctx: MongoMigrationContext): Promise<void> {
  await ctx.db("auth").collection("users").updateMany({}, { $unset: { verified: "" } });
}
```

### Explicit schemas are shared by every tenant

An explicit schema is the same in every deployment: all tenants read and write the same `auth/users` and `billing-eu/invoices`. `migration add` marks each statement that changes an explicit-schema table with its schema:

```ts title="migrations/20261016222536_Initial.ts"
await ctx.sql("CREATE TABLE `billing_eu__invoices` (...);", { schema: "billing-eu" });
await ctx.sql("CREATE TABLE `{{default_schema}}users` (...);");
```

Each explicit schema keeps its own migration history, next to its tables (`billing_eu____quickservicets_migrations` on SQLite, `billing_eu.__quickservicets_migrations` on PostgreSQL). `migrate` runs a marked statement only when that history does not have the migration yet, so several tenants can migrate the same database:

```bash
DATABASE_SCHEMA=tenant-a bun run quickservicets migrate
# Applied 20261016222536_Initial
DATABASE_SCHEMA=tenant-b bun run quickservicets migrate
# Applied 20261016222536_Initial
```

The first run creates `tenant_a__users`, `auth__users` and `billing_eu__invoices`; the second only creates `tenant_b__users`. The history of `billing-eu` records the migration once, with the default schemas that applied it: `tenant-a` and `tenant-b`. Each migration still runs in one transaction, so a failing statement leaves every history as it was.

## Naming rules

Schema names, from folders, `@schema`, `schema` or `DATABASE_SCHEMA`, must match `^[a-z][a-z0-9-]*$`: lowercase, starting with a letter, with digits and hyphens. Mistakes stop the build or the start with a message that names the problem:

```
entities/Bad.ts: schema "Billing" must match ^[a-z][a-z0-9-]*$
entities/a/b: entities may only be nested one folder deep
entities/Bad.ts and entities/auth/User.ts collide: collection "auth" has the same name as schema "auth"
Invalid DATABASE_SCHEMA: "Bad" must match ^[a-z][a-z0-9-]*$
```

The last rule exists because `/auth` would be both the route of a collection and the prefix of a schema. Two entities may share a type or collection name only in different schemas.

## Variations

### Separate uploads per tenant

The default schema does not change storage keys of default-schema file entities, so tenants share the `uploads/` folder unless you split it. The config is a module, so it can read the variable too:

```ts
import { defineConfig, localStorage, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  storage: { default: localStorage({ dir: `uploads/${process.env.DATABASE_SCHEMA || "shared"}` }) },
});
```

### One database file per tenant on SQLite

On SQLite you can also skip schemas and point each deployment at its own file, `DATABASE_PATH=tenant-a.db`. Then explicit schemas are no longer shared between tenants.

## Related

- [`@schema`](/reference/tags/#schema) and the other entity tags
- [Configuration: `schema`](/reference/config/)
- [CLI: `migrate` and `migration add`](/reference/cli/#migrate)
- [Repository API](/reference/api/)

Previous: [Pagination in custom endpoints](/recipes/pagination/). Next: [Testing your API in-process](/recipes/testing/).
