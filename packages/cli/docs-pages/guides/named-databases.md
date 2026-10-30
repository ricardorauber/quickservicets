# Named databases

> Split a service's modules across several databases, each entity living in one of them, knowing exactly what stays consistent across them and what does not.

One service can use several databases at once: the default one (`database`) and named ones (`databases`), each a module of the service, like `orders` on PostgreSQL and `catalog` on MongoDB. Every entity lives in exactly one database, chosen by its folder or a tag; routes, repositories, types and the API docs stay the same wherever it lives. The samples come from the example project `examples/named-databases`: customers in a default SQLite database, orders and their lines in a named `orders` database.

## When to split databases

Split when modules have different needs: a different engine (documents for a catalog, SQL for orders), a different owner or backup policy, a different scale, or data that must stay in its own place. Keep one database when the modules change together: a transaction covers one database, so the data you update together belongs together.

## Configuring them

`databases` names each one; a value is an adapter, or `{ adapter, tenancy?, tenantConnection? }`:

```ts title="quickservicets.config.ts"
import { defineConfig, mongodbAdapter, postgresAdapter, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" }),
  databases: {
    orders: postgresAdapter({ url: process.env.ORDERS_DATABASE_URL ?? "postgres://localhost:5432/orders" }),
    catalog: mongodbAdapter({ url: process.env.CATALOG_DATABASE_URL ?? "mongodb://localhost:27017/?replicaSet=rs0", database: "catalog" }),
  },
});
```

- Names match `^[a-z][a-z0-9-]*$`; `default` is the name of `database` in messages and cannot be used.
- `QS_DATABASES_<NAME>_URL` (like `QS_DATABASES_ORDERS_URL`) replaces a database's connection through its adapter: a URL for PostgreSQL and MongoDB (the URL path names the MongoDB database), a file path for SQLite. It is a secret, masked in logs, reports and `env check`, and refused for memory databases.
- The service connects every database at startup, default first then by name, and stops with `Cannot connect database orders (postgres): <reason>` (exit code 4 for the CLI) without the password when one is unreachable. A clean stop closes every connection.

## Choosing a database: folder or `@database`

An entity in a module folder named like a database lives there; `@database <name>` places any entity, and `@database default` keeps one of the folder in the default database:

```ts title="entities/Customer.ts"
export type Customer = { name: string };
```

```ts title="entities/orders/Order.ts"
import type { Customer } from "../Customer.ts";

// In the orders database, by its folder; served at /orders/orders as repos.orders.orders.
export type Order = { number: string; customer: Customer };
```

```ts title="entities/Product.ts"
/** @database catalog */
export type Product = { name: string };
```

An unknown name fails the build: `entities/Product.ts: unknown database nope (configured: default, orders, catalog)`. Moving an entity between databases changes no application code.

## References across databases and what is not enforced

`Order.customer` references a customer of another database. It is allowed, and the build says what it means:

```text
Order.customer references Customer in database default; there is no database-level integrity or cascade for it
```

- No foreign key exists for it. Creating, updating or replacing an order checks the customer exists with a query on the default database and answers 400 `Referenced record not found` otherwise.
- `populate` (`GET /orders/orders?populate=customer`) loads the customers with one query on their database per path, nested paths included.
- Relations kept in sync on both sides (`@inverse`, `@owner`) need both entities in one database and fail the build otherwise.

## Delete rules

- `restrict` (the default) is checked by the application: deleting a customer still referenced by an order answers 409 `CONFLICT`. The check runs before the delete's transaction and is not atomic: an order created between the check and the delete can keep a dangling id.
- `pull` (the default of reference arrays) removes the id from the arrays of the other database record by record, after the delete, also not atomically.
- `@onDelete cascade` and `@onDelete setNull` fail the build across databases: `@onDelete cascade is not available across databases (Order in orders, Customer in default); use restrict, or a listener or saga to clean up`.

## Transactions, sagas and the outbox

A transaction belongs to one database: the one of the first entity it touches, or the one it names.

```ts title="endpoints/checkout/post.ts"
import { transaction, type Endpoint } from "@quickservicets/core";

type Checkout = { number: string; customer: string };

const handler: Endpoint = async (_repos, req) => {
  const body = (await req.json()) as Checkout;
  return transaction(async () => {
    // Writes of orders entities (repos.orders.orders, repos.orders.orderLines) join this transaction; a read or write
    // of another database's entity throws CROSS_DATABASE_TRANSACTION.
    return { placed: body.number, for: body.customer };
  }, { database: "orders" });
};

export default handler;
```

- Reading or writing another database inside it throws `CROSS_DATABASE_TRANSACTION` (500): `Cannot use Customer (database default) inside a transaction of database orders; a transaction covers one database. Use a saga or the outbox for changes across databases`. Reads are refused too, so code never believes a read is consistent with the transaction.
- A nested transaction joins only one of the same database; `afterCommit` callbacks run after the commit of their database.
- Generated routes write in a transaction of the entity's database and run their checks across databases before it.
- For changes across databases, emit an event or add a queue message in the transaction and apply the other side in its consumer (a saga), or read the outbox. Queue messages, outbox deliveries and events written in a transaction of `orders` while their tables live elsewhere are staged in `orders` and relayed after the commit, at least once, so enqueueing stays atomic with the writes. Write events, queue messages and error reports carry `database: "orders"`.

## Where feature tables live

- Tables of one entity follow it: the history of `Order` lives in `orders` and is written in the order's transaction.
- Per-database tables exist in every database that holds entities: each one has its outbox, written by its own transactions and read together.
- Every other feature table (queue messages, job runs, idempotency keys, flags, metrics, rate limit counters, tenants) lives in the default database. Every feature has the option `database` (`QS_<KEY>_DATABASE`) to move them: `queues: { database: "orders" }`. Each feature's reference page lists where its entities live.

## Migrations per database

`migrations/` serves the default database and `migrations/<name>/` each named one, each with its own snapshots and history table. `migration add <Name>` writes one file with one timestamp in each database whose model changed, `migrate` applies every database (or one with `--database orders`), and `migration list` groups by database. See [Migrations](/guides/migrations/#named-databases).

## Tenancy per database

With the tenancy native, a named database is per tenant by default, or shared with `tenancy: "shared"`: tenants keep their own orders while sharing one catalog. The schema strategy uses each tenant's schema in every per-tenant database, and the database strategy opens `tenantConnection` (like `"orders_{tenant}.db"`). See [Multi-tenancy](/guides/multi-tenancy/#named-databases).

## Health

With `health: {}`, readiness runs one critical check per database, `database` and `database:<name>`, so one unreachable database makes the instance not ready and the answer names it. The startup log lists each database's kind and entity count, like `databases: default sqlite (1 entity), orders postgres (2 entities)`, never a connection.

## Tests

`startTestService` runs every named database in memory unless the test gives an adapter, so tests need no database server:

```ts title="tests/orders.test.ts"
import { expect, test } from "bun:test";
import { startTestService } from "@quickservicets/cli/testing";

test("orders are served from the orders database", async () => {
  const service = await startTestService({ files: { "entities/orders/Order.ts": "export type Order = { number: string };\n" } });
  try {
    expect((await service.fetch("/orders/orders")).status).toBe(200);
  } finally {
    await service.stop();
  }
});
```

Pass `databases: { orders: sqliteAdapter({ path: ":memory:" }) }` to run one on another adapter, or `databases: "config"` to keep the project's.

## Moving an entity between databases

Changing an entity's folder or `@database` moves its table: the next `migration add` drops it (marked `// WARNING: possible data loss`) in the old database's migration and creates it in the new one, and the build prints `Moving Note from default to orders does not copy its data`. Copy the records before applying the migrations, then apply both.
