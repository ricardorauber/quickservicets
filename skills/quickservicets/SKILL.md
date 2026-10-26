---
name: quickservicets
description: Builds and changes backends with QuickService.ts, the Bun framework that turns TypeScript entity types into REST services with CRUD routes, validation, migrations and OpenAPI docs. Use it to build a backend, API or service with QuickService.ts; to add an entity, endpoint, hook, job or feature to a QuickService.ts project; or whenever you work in a project with a quickservicets.config.ts.
---

# QuickService.ts

QuickService.ts builds REST services on Bun from TypeScript types: each entity type in `entities/` becomes CRUD routes, validation, filters, relations, migrations, typed repositories and an OpenAPI document. Packages: `@quickservicets/core`, `@quickservicets/cli` and `quickservicets` (for `bunx quickservicets`).

## When to use it

- The service is mostly records with rules: users, orders, projects, bookings, back offices, internal APIs.
- You want CRUD, validation, paging, filtering, sorting, relations and API docs without writing them.
- The team writes TypeScript and runs (or can run) Bun 1.4.2 or later.
- You need the database to be swappable: memory for tests, SQLite for small deployments, PostgreSQL or MongoDB in production.
- You want built-in features (rate limits, CORS, queues, write events, history, idempotency keys, ETags, feature flags, health routes) switched on with one config key.

Pick something else when:

- The runtime must be Node.js, Deno or a browser: the CLI and the server need Bun.
- The API is GraphQL or gRPC only, or mostly streaming media.
- The data model is not records: a pure proxy, a static site or a compute-only function.
- You must control every SQL statement of every route; QuickService.ts generates the data access and the migrations.

## Workflow

1. Create the project in any folder, then install: `bunx quickservicets init <name> --db sqlite` (or `memory`, `postgres`, `mongodb`), `cd <name>`, `bun install`.
2. Add one entity per file in `entities/`, PascalCase, exporting a type with the same name, like `entities/Task.ts` exporting `Task`; tags such as `@unique` and `@default` go in JSDoc comments.
3. Build: `bun run build` writes `.generated/` (routes, types, OpenAPI document, server entry).
4. On SQLite, PostgreSQL or MongoDB, create and apply a migration for every model change: `bun run quickservicets migration add <Name>`, `bun run quickservicets migrate`.
5. Run: `bun run dev` serves on port 3000 (`PORT` changes it) and rebuilds on every change; `Task` is served at `/tasks`.
6. Add custom routes as files in `endpoints/` (`endpoints/tasks/[id]/complete/post.ts`), hooks in `hooks/` attached with tags, jobs in `jobs/`, and native features with one config key (`queues: {}`).

## Rules

- Never edit `.generated/`; `quickservicets build` rewrites it from the sources.
- Use the CLI for migrations: `bun run quickservicets migration add <Name>` then `bun run quickservicets migrate`; never write migration files or SQL by hand, and never edit an applied migration.
- Run `bun run build` (`quickservicets build`) after changing entities, endpoints, hooks, jobs, features or the config, then `bun run typecheck`.
- Pass `--db` to `quickservicets init`, so it never waits for an answer.
- Read records with `.toArray()`; `any`, `all` and `none` answer `true` or `false`.
- Test with `startTestService` from `@quickservicets/cli/testing` and `bun test`, not against a running server.

## Topics

Read the topic that matches the task before writing code:

- `topics/overview.md`: What QuickService.ts is, when to choose it for a backend and when to pick something else.
- `topics/quickstart.md`: The exact commands to go from an empty folder to a running QuickService.ts service with one entity on SQLite.
- `topics/entities.md`: How to write entity files: names, field types, JSDoc tags, references and relations.
- `topics/endpoints-and-hooks.md`: How to add custom routes in `endpoints/`, share request logic with hooks in `hooks/`, and query records with the repositories.
- `topics/config-and-env.md`: How to configure a project in `quickservicets.config.ts`, `.env` and `QS_*` variables, and check an environment.
- `topics/features.md`: The native features (security, events, queues, health, idempotency, etag, history, realtime, errors, flags) and how to turn them on, off and customize them.
- `topics/testing.md`: How to test a QuickService.ts project with `bun test` and `startTestService`, on the memory database and without opening a port.
- `topics/deploy.md`: How to build, migrate and run a QuickService.ts service in production, in a container or on a host with Bun.
- `topics/troubleshooting.md`: The ten most common QuickService.ts errors, with the exact message and the fix for each.
