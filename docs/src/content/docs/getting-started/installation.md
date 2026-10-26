---
title: Installation and init
description: Create a QuickService project with the init command.
sidebar:
  order: 2
---

The `init` command creates an empty project, ready for your first entity. This page creates one called `my-api` that uses the in-memory database, so you need nothing else installed.

## What you need

- [Bun](https://bun.sh), which runs the framework, the CLI and your project.
- A clone of the QuickService repository, with its dependencies installed:

```bash
bun install
```

:::note
The packages are not on npm yet, so your project lives inside the repository, under `examples/`. Run every command on this page from the repository root, where `bunx quickservice` runs the repository's own CLI.
:::

## Create a project

```bash
bunx quickservice init examples/my-api --db memory
```

It prints the next steps:

```text
Next steps:
  1. Create an entity, e.g. entities/User.ts: export type User = { email: string }
  2. Start the dev server: bun run dev
```

Inside the repository, `init` notices the workspace. It writes `"workspace:*"` for `@quickservice/core` and `@quickservice/cli` in the new `package.json`, and runs `bun install` at the repository root, so the packages are linked right away.

The target folder must be empty or not exist yet; otherwise `init` stops with `Directory is not empty`.

## What init creates

```text
examples/my-api/
├── .env                       # database settings (empty for memory)
├── .gitignore                 # .env, dependencies and generated files
├── entities/                  # your entity types
├── endpoints/                 # your custom routes
├── hooks/                     # your hooks
├── package.json               # dependencies and scripts
├── quickservice.config.ts     # the project configuration
└── tsconfig.json
```

The three folders start with a `.gitkeep` file. The config uses the database you chose:

```ts check title="quickservice.config.ts"
import { defineConfig, memoryAdapter } from "@quickservice/core";

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

Inside the project, the CLI is available as `bun run quickservice <command>`. The project also has four scripts:

| Script | Runs |
| --- | --- |
| `bun run dev` | `quickservice dev`: builds, serves and rebuilds on every change |
| `bun run build` | `quickservice build`: writes `.generated/` |
| `bun run migrate` | `quickservice migrate`: applies pending migrations |
| `bun run start` | `bun .generated/server.ts`: starts the last build |

Every command and flag is in the [CLI reference](/reference/cli/), and every config key in the [configuration reference](/reference/config/).

## Next

[Your first entity](/getting-started/first-entity/): describe a user and start the server.
