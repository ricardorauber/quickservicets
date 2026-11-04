# 0098 - The Drizzle schema builders stay loaded with the core; the database drivers load on connect

- Date: 2026-11-04
- Spec: 0313-lazy-loading-and-startup-timing
- Status: accepted

## Context
Spec 0313 R1 asks that importing `@quickservicets/core` load neither the MongoDB driver, "Drizzle dialects" nor other adapter drivers, each adapter importing its driver inside `connect`; AC1 checks `mongodb`. The core's SQL support has two kinds of Drizzle modules: the drivers (`drizzle-orm/bun-sql`, `drizzle-orm/bun-sqlite`), which bind Drizzle to a connection, and the schema builders (`drizzle-orm/pg-core`, `drizzle-orm/sqlite-core`), which the model-to-table mapping, the statement builders and the migration generator call synchronously and which the core exports (`buildDrizzleSchema`).

## Options considered
- A: Load every driver (MongoDB, `bun:sqlite` with `drizzle-orm/bun-sqlite`, `drizzle-orm/bun-sql`) inside `connect`, and keep the schema builders, plain JavaScript without I/O, loaded with the core. Small change; synchronous APIs stay as they are.
- B: Also load the schema builders lazily. Every synchronous caller (the adapters' statement builders, `buildDrizzleSchema`, the migration generator and the testing helpers) would need an asynchronous loading step first, a broad change for a few milliseconds of module evaluation.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `mongodbAdapter`, `postgresAdapter` and `sqliteAdapter` import their drivers when they connect, not when they are created; a test checks that importing the core and creating adapters loads no MongoDB module.
- The schema builders remain part of the core's import; the cold-start benchmark of spec 0317 shows their cost with the rest of the startup.
