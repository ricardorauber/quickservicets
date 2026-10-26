---
title: Installation and init
description: Create a QuickService.ts project with the init command.
sidebar:
  order: 2
---

The `init` command creates an empty project, ready for your first entity. This page creates one called `my-api` that uses the in-memory database, so you need nothing else installed.

## What you need

- [Bun](https://bun.sh) 1.4.2 or later, which runs the framework, the CLI and your project.

## Create a project

In any folder:

```bash
bunx quickservicets init my-api --db memory
cd my-api
bun install
```

`bunx` downloads the `quickservicets` command from npm and runs it. It prints the next steps:

```text
Next steps:
  1. Install dependencies: bun install
  2. Create an entity, e.g. entities/User.ts: export type User = { email: string }
  3. Start the dev server: bun run dev
```

The new `package.json` depends on `@quickservicets/core` and `@quickservicets/cli` at the version of the CLI that created it, like `"^0.1.0"`, and `bun install` installs them from npm. It also adds `@types/bun` and `typescript` as dev dependencies and a `typecheck` script, so `bun run typecheck` checks the project with `tsc --noEmit` right after the install.

The target folder must be empty or not exist yet; otherwise `init` stops with `Directory is not empty`.

## What init creates

```text
my-api/
├── .env                       # database settings (empty for memory)
├── .gitignore                 # .env, dependencies and generated files
├── entities/                  # your entity types
├── endpoints/                 # your custom routes
├── hooks/                     # your hooks
├── package.json               # dependencies and scripts
├── quickservicets.config.ts     # the project configuration
└── tsconfig.json
```

The three folders start with a `.gitkeep` file. The config uses the database you chose:

```ts check title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
});
```

[Project structure](/getting-started/project-structure/) explains each file in detail.

## Choose a database

`--db` takes one of four values. Without it, `init` asks you to pick one.

| `--db` | Adapter | Settings written to `.env` |
| --- | --- | --- |
| `memory` | `memoryAdapter()` | none |
| `sqlite` | `sqliteAdapter(...)` | `DATABASE_PATH=data.db` |
| `postgres` | `postgresAdapter(...)` | `DATABASE_URL` |
| `mongodb` | `mongodbAdapter(...)` | `DATABASE_URL` and `DATABASE_NAME` |

The memory database is the quickest way to start: there is nothing to run and no migrations to apply. Its data is lost when the server stops, so switch to another database once your model settles. Bun reads `.env` on its own when the server starts.

:::caution
The `postgres` and `mongodb` values in `.env` are placeholders. Replace them with your own connection settings before you start the server.
:::

## Run the CLI

Inside the project, the CLI is available as `bun run quickservicets <command>`. The project also has four scripts:

| Script | Runs |
| --- | --- |
| `bun run dev` | `quickservicets dev`: builds, serves and rebuilds on every change |
| `bun run build` | `quickservicets build`: writes `.generated/` |
| `bun run migrate` | `quickservicets migrate`: applies pending migrations |
| `bun run start` | `bun .generated/server.ts`: starts the last build |

Every command and flag is in the [CLI reference](/reference/cli/), and every config key in the [configuration reference](/reference/config/).

## Working from a clone

To work on QuickService.ts itself, or to try a change before it is published, create projects inside a clone of the [repository](https://github.com/ricardorauber/quickservicets). Install its dependencies once, from the repository root:

```bash
bun install
```

Then create the project under `examples/`, from the repository root, where `bunx quickservicets` runs the repository's own CLI:

```bash
bunx quickservicets init examples/my-api --db memory
```

Inside the repository, `init` notices the workspace. It writes `"workspace:*"` for `@quickservicets/core` and `@quickservicets/cli` in the new `package.json` (the dev dependencies, scripts and `tsconfig.json` are the same as outside) and runs `bun install` at the repository root, so the workspace packages are linked right away and there is no install step in its next steps.

## Next

[Your first entity](/getting-started/first-entity/): describe a user and start the server.
