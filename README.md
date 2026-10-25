# QuickService

Build backend services from TypeScript entity types. Write an entity as a `type` with JSDoc tags in `/entities`, and QuickService generates its CRUD routes, validation, filters, relations, file uploads, migrations and OpenAPI docs, on Bun with an in-memory, SQLite, PostgreSQL or MongoDB database.

This monorepo holds `@quickservice/core` (runtime), `@quickservice/cli` (the `quickservice` command) and examples in `examples/`.

## Documentation

The developer documentation is a Starlight site in `docs/`:

```bash
bun run docs:dev     # serves it at http://localhost:4321
bun run docs:build   # builds the static site into docs/dist
```

## Getting started

To build a first project, follow the [Getting started](docs/src/content/docs/getting-started/index.md) section of the docs (served at http://localhost:4321/getting-started/ by `bun run docs:dev`). It covers installing, creating a project with `init`, writing a first entity and calling its API.

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

Two more checks guard contributions. `bun run typecheck` also fails when code outside `packages/core/src/adapters/` passes SQL text built at runtime to `unsafe()`: pass values as parameters, or put `// quickservice-allow-unsafe: <reason>` on the line above a call that must build its text. `bun run audit` runs `bun audit` and fails on a critical vulnerability unless `scripts/audit-allow.json` lists it with an id, package, reason and `expires` date; the test suite runs it when `CI` is set.
