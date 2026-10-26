# Quickstart

The exact commands to go from an empty folder to a running QuickService.ts service with one entity on SQLite.

You need Bun 1.4.2 or later (`bun --version`). Run every step in order; each command is meant to be copied as it is.

## 1. Create the project

In any folder outside another QuickService.ts project:

```bash
bunx quickservicets init my-api --db sqlite
cd my-api
bun install
```

`--db` takes `memory`, `sqlite`, `postgres` or `mongodb`. Always pass it: without it, `init` asks. SQLite needs nothing else installed and keeps its data in `data.db`; `memory` needs no migrations but loses its data on every restart. For `postgres` and `mongodb`, put the real connection settings in `.env` before step 4.

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

It prints `Built 3 entities, 0 custom endpoints and 0 hooks.` (the count includes the built-in `File` and `Media` entities) and writes `.generated/`.

## 4. Create and apply the migration

SQLite, PostgreSQL and MongoDB need a migration for every model change (skip this step with `--db memory`):

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
3. `bun run quickservicets migration add <Name>` with a name for the change, like `AddPriorityToTasks`.
4. `bun run quickservicets migrate`.

Run `bun run typecheck` after `bun run build` to type-check the project.

Full docs: [Getting started](/getting-started/installation/)

## Do not

- Do not leave out `--db`; `init` would wait for an answer.
- Do not run `init` in a folder that has files; it stops with `Directory is not empty`.
- Do not skip `bun install`; the project depends on `@quickservicets/core` and `@quickservicets/cli`.
- Do not write migration files or SQL by hand, and do not edit an applied migration.
- Do not edit `.generated/`; rebuild instead.
- Do not start the service before `migrate` on SQLite, PostgreSQL or MongoDB; the tables would not exist.
- Do not use `npx`; use `bunx` and `bun run`.
