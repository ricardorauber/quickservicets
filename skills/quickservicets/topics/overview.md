# Overview

What QuickService.ts is, when to choose it for a backend and when to pick something else.

QuickService.ts builds REST services on Bun from TypeScript types. You write each entity as a `type` in `entities/`, and `quickservicets build` generates its CRUD routes, validation, filters, relations, file uploads, migrations, typed repositories and an OpenAPI document. Custom routes are files in `endpoints/`, shared request logic is hooks in `hooks/` attached with JSDoc tags, and scheduled work is jobs in `jobs/`. The same project runs on an in-memory database, SQLite, PostgreSQL or MongoDB.

The framework ships as three npm packages: `@quickservicets/core` (the runtime), `@quickservicets/cli` (the `quickservicets` command) and `quickservicets` (so `bunx quickservicets` runs that command without installing anything).

## Use it when

- The service is mostly records with rules: users, orders, projects, bookings, back offices, internal APIs.
- You want CRUD, validation, paging, filtering, sorting, relations and API docs without writing them.
- The team writes TypeScript and runs (or can run) Bun 1.4.2 or later.
- You need the database to be swappable: memory for tests, SQLite for small deployments, PostgreSQL or MongoDB in production.
- You want built-in features (rate limits, CORS, queues, write events, history, idempotency keys, ETags, feature flags, health routes) switched on with one config key.

## Do not use it when

- The runtime must be Node.js, Deno or a browser: the CLI and the server need Bun.
- The API is GraphQL or gRPC only, or mostly streaming media.
- The data model is not records: a pure proxy, a static site or a compute-only function.
- You must control every SQL statement of every route; QuickService.ts generates the data access and the migrations.

## How a project works

1. `bunx quickservicets init <name> --db <database>` creates the project in any folder.
2. You add entity types to `entities/`, endpoint files to `endpoints/`, hooks to `hooks/` and jobs to `jobs/`.
3. `bun run build` (or `bun run dev`, which also serves and rebuilds on save) writes `.generated/`: models, routes, types, the OpenAPI document and the server entry.
4. For SQLite, PostgreSQL and MongoDB, `quickservicets migration add <Name>` writes a migration from the model changes and `quickservicets migrate` applies it.
5. `bun run start` runs the last build in production.

Each entity `Task` in `entities/Task.ts` is served at `/tasks` (list, read, create, update, replace, delete) and is `repos.tasks` in endpoints, hooks and jobs.

Full docs: [Introduction](/getting-started/)

## Do not

- Do not pick QuickService.ts for a Node.js-only runtime; it needs Bun.
- Do not hand-write CRUD routes for an entity; the build generates them.
- Do not edit files in `.generated/`; every build overwrites them.
- Do not write SQL migrations by hand; `quickservicets migration add <Name>` writes them from the model.
- Do not add Express, Hono or another HTTP framework; routes are files in `endpoints/`.
