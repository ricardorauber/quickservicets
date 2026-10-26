# QuickService.ts

[![quickservicets on npm](https://img.shields.io/npm/v/quickservicets?label=quickservicets)](https://www.npmjs.com/package/quickservicets)
[![@quickservicets/core on npm](https://img.shields.io/npm/v/@quickservicets/core?label=%40quickservicets%2Fcore)](https://www.npmjs.com/package/@quickservicets/core)
[![@quickservicets/cli on npm](https://img.shields.io/npm/v/@quickservicets/cli?label=%40quickservicets%2Fcli)](https://www.npmjs.com/package/@quickservicets/cli)

Build backend services from TypeScript entity types. Write an entity as a `type` with JSDoc tags in `/entities`, and QuickService.ts generates its CRUD routes, validation, filters, relations, file uploads, migrations and OpenAPI docs, on Bun with an in-memory, SQLite, PostgreSQL or MongoDB database.

The source lives at [github.com/ricardorauber/quickservicets](https://github.com/ricardorauber/quickservicets).

This monorepo holds `@quickservicets/core` (runtime), `@quickservicets/cli` (the `quickservicets` command), `quickservicets` (which runs that command with `bunx quickservicets`) and examples in `examples/`.

## Documentation

The developer documentation is a Starlight site in `docs/`:

```bash
bun run docs:dev     # serves it at http://localhost:4321
bun run docs:build   # builds the static site into docs/dist
```

## Getting started

Create a project in any folder with [Bun](https://bun.sh) 1.4.2 or later:

```bash
bunx quickservicets init my-api --db sqlite
cd my-api
bun install
bun run dev
```

To build a first project step by step, follow the [Getting started](docs/src/content/docs/getting-started/index.md) section of the docs (served at http://localhost:4321/getting-started/ by `bun run docs:dev`). It covers installing, creating a project with `init`, writing a first entity and calling its API.

## Features

Everything beyond the generated API is a feature turned on by a key in `quickservicets.config.ts`. A project can write its own in `features/<key>/`, with the same extension points as the framework's native features, or replace a native with one; the [Project features](docs/src/content/docs/guides/project-features.md) guide shows how.

## Using PostgreSQL or MongoDB

Run `init` with `--db postgres` or `--db mongodb` and set the values in the `.env` it creates: `DATABASE_URL`, plus `DATABASE_NAME` for MongoDB.

A quick local PostgreSQL:

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres:16
# DATABASE_URL=postgres://postgres:pass@localhost:5432/postgres
```

MongoDB has to run as a replica set, because writes that update both sides of a relation use transactions.

## Running the tests

```bash
bun test
```

Tests against real databases and S3 run only when these are set; otherwise they are skipped:

- `TEST_POSTGRES_URL`
- `TEST_MONGODB_URL`
- `TEST_S3_BUCKET`, `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY`

Type-check every project of the repository (the test suite runs this too):

```bash
bun run typecheck
```

Two more checks guard contributions. `bun run typecheck` also fails when code outside `packages/core/src/adapters/` passes SQL text built at runtime to `unsafe()`: pass values as parameters, or put `// quickservicets-allow-unsafe: <reason>` on the line above a call that must build its text. `bun run audit` runs `bun audit` and fails on a critical vulnerability unless `scripts/audit-allow.json` lists it with an id, package, reason and `expires` date; the test suite runs it when `CI` is set.
