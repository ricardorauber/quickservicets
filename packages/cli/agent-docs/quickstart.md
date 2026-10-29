# Quickstart

The exact commands to go from an empty folder to a running QuickService.ts service with one entity, on the in-memory database or on SQLite, PostgreSQL or MongoDB.

You need Bun 1.4.2 or later (`bun --version`). Run every step in order; each command is meant to be copied as it is.

## 1. Create the project

In any folder outside another QuickService.ts project:

```bash
bunx quickservicets init my-api
cd my-api
bun install
```

`init` asks nothing: without `--db` the project runs on the in-memory database, which needs no migrations and loses its data on every restart. To choose another database, pass `--db sqlite`, `--db postgres` or `--db mongodb` (`bunx quickservicets init my-api --db sqlite`). SQLite needs nothing else installed and keeps its data in `data.db`; for `postgres` and `mongodb`, put the real connection settings in `.env` before step 4. A memory project can switch later with one line in `quickservicets.config.ts`, like `database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" })`.

## 2. Add an entity

Create `entities/Task.ts`. The file name and the exported type name must match, in PascalCase:

```ts
// entities/Task.ts
export type Task = {
  /** @minLength 1 */
  title: string;
  /** @default false */
  done: boolean;
  dueAt?: Date;
};
```

Never declare `id`, `createdAt` or `updatedAt`; every entity gets them.

## 3. Build

```bash
bun run build
```

It prints `Built 1 entity, 0 custom endpoints and 0 hooks.` and writes `.generated/`.

## 4. Create and apply the migration (SQLite, PostgreSQL and MongoDB only)

On the in-memory database, skip this step. SQLite, PostgreSQL and MongoDB need a migration for every model change:

```bash
bun run quickservicets migration add CreateTasks
bun run quickservicets migrate
```

`migration add` writes `migrations/<timestamp>_CreateTasks.ts` from the model; `migrate` applies it.

## 5. Run the service

```bash
bun run dev
```

It prints `QuickService.ts listening on http://localhost:3000` and keeps running: it rebuilds and restarts on every saved change. Set `PORT=4000` before the command for another port. In a script, run it in the background and wait for that line.

## 6. Call the API

```bash
curl -X POST localhost:3000/tasks -H "content-type: application/json" -d '{"title":"Write the docs"}'
curl localhost:3000/tasks
```

The list answers `{"data":[...],"total":1,"limit":20,"offset":0}`. Filters use brackets, so pass `-g` to curl:

```bash
curl -g "localhost:3000/tasks?where[done][eq]=false&sort=-createdAt"
```

The API docs are at `http://localhost:3000/docs`.

## After every model change

1. Edit or add files in `entities/`.
2. `bun run build` (`bun run dev` rebuilds by itself).
3. On SQLite, PostgreSQL or MongoDB, `bun run quickservicets migration add <Name>` with a name for the change, like `AddPriorityToTasks`.
4. On SQLite, PostgreSQL or MongoDB, `bun run quickservicets migrate`.

Run `bun run typecheck` after `bun run build` to type-check the project.

## In scripts and agents

- Add `--json` to the commands that report results (`build`, `migration add`, `migration list`, `migrate`, `job list`, `job runs`, `env check`, and list commands like `queue list`): they print one JSON document to stdout, `{"ok":true,...}` or `{"ok":false,"error":{"code","message"}}`, and the logs to stderr.
- Add `--yes` (or run with `CI=true`) so no command ever waits for an answer: a question with a safe answer takes it, and one without exits 2 naming the flag to pass.
- Check the exit code: 0 success, 1 the operation failed, 2 usage error or a missing answer, 3 configuration error, 4 database unreachable.

```bash
bun run quickservicets build --json
bun run quickservicets migrate --json --yes
```

Full docs: [Getting started](/getting-started/installation/)

## Do not

- Do not run `init` in a folder that has files; it stops with `Directory is not empty`.
- Do not skip `bun install`; the project depends on `@quickservicets/core` and `@quickservicets/cli`.
- Do not write migration files or SQL by hand, and do not edit an applied migration.
- Do not edit `.generated/`; rebuild instead.
- Do not start the service before `migrate` on SQLite, PostgreSQL or MongoDB; the tables would not exist.
- Do not use `npx`; use `bunx` and `bun run`.
