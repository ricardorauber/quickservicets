# Named databases example

A small shop split across two databases with QuickService.ts: customers live in the default database, and orders with their lines live in a named database, `orders`. Both are SQLite files here; `orders` switches to PostgreSQL with one variable.

| Entity | Database | Fields |
| --- | --- | --- |
| `Customer` (`entities/Customer.ts`) | default | `name`, `email?` |
| `Order` (`entities/orders/Order.ts`) | `orders`, by its folder | `number`, `customer` (a reference to the default database), `paid` |
| `OrderLine` (`entities/orders/OrderLine.ts`) | `orders` | `order` (`@onDelete cascade`), `sku`, `quantity` |

`POST /checkout` creates an order and its lines in one transaction of the `orders` database (`transaction(fn, { database: "orders" })`): all of them or none.

## What holds across the two databases

- `Order.customer` has no foreign key: the build prints `Order.customer references Customer in database default; there is no database-level integrity or cascade for it`, and every write checks the customer exists with a query on the default database (400 `Referenced record not found` otherwise).
- Deleting a customer that still has orders answers 409; the check runs before the delete and is not atomic with it.
- `GET /orders/orders?populate=customer` loads the customers with one query on the default database.
- A transaction covers one database: touching a customer inside an orders transaction throws `CROSS_DATABASE_TRANSACTION`.

## Run it

```bash
bun install
bun run build
bun run quickservicets migration add Init   # writes migrations/ and migrations/orders/
bun run quickservicets migrate              # applies both, default first
bun run dev
```

Each database keeps its own migrations and history:

```bash
bun run quickservicets migrate --database orders   # only the orders database
bun run quickservicets migration list              # grouped by database
```

## Orders on PostgreSQL

Keep the config as it is and set the connection of the `orders` database when deploying; the variable is a secret and never printed:

```bash
QS_DATABASES_ORDERS_URL=postgres://app:secret@db.internal:5432/orders bun run quickservicets migrate
QS_DATABASES_ORDERS_URL=postgres://app:secret@db.internal:5432/orders bun run start
```

Migrations are written per dialect, so create the `orders` migrations with the variable set too (or write the adapter in the config, as the commented line shows).

## Tests

```bash
bun test tests
```

The tests run the project with `startTestService` on memory databases, with no database server: CRUD in both databases, the reference checks, `populate`, the delete rule, the checkout transaction, the refused transaction across databases, and `migration add` writing both folders.
