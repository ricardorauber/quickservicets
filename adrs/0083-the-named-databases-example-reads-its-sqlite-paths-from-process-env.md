# 0083 - The named databases example reads its SQLite paths from process.env

- Date: 2026-10-29
- Spec: 0887-named-databases-customization-example-and-guide
- Status: accepted

## Context
Spec 0887 R1 asks `examples/named-databases` to configure `database: sqliteAdapter({ path: env.DATABASE_PATH })` and
`databases: { orders: sqliteAdapter({ path: env.ORDERS_DATABASE_PATH }) }`. Inside `quickservicets.config.ts`, `env`
holds the declared variables only once the configuration is resolved, and reading it while the config file loads
throws `env.DATABASE_PATH was read before the configuration was resolved; use process.env inside
quickservicets.config.ts` (the same finding as ADR 0081). Written as the spec says, the example would not build.

## Options considered
- A: Read the paths with `process.env`, with a fallback so the example runs without a `.env`:
  `sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" })` and
  `sqliteAdapter({ path: process.env.ORDERS_DATABASE_PATH ?? "orders.db" })`, like the SQLite project `init` writes.
- B: Write the lines exactly as the spec does: the example fails to build.
- C: Make `env` readable while the config file loads: a change to spec 0139's contract outside this spec.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The example's config reads `process.env.DATABASE_PATH` and `process.env.ORDERS_DATABASE_PATH` with fallbacks.
Spec 0887 R1 should name these lines when it is next updated.
