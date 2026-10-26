# Project structure

> What each file and folder of a QuickService.ts project is for.

A project is a handful of folders with fixed names. You write three of them, and `build` writes the rest. Here is `my-api` after it grows a custom endpoint and a hook:

```text
my-api/
├── .env                       # environment variables, read by Bun
├── .generated/                # written by build — do not edit
│   ├── models.ts
│   ├── openapi.json
│   ├── routes.ts
│   ├── server.ts
│   └── types.ts
├── endpoints/
│   └── health/
│       └── get.ts             # GET /health
├── entities/
│   └── User.ts                # /users
├── features/                  # your own features, optional
│   └── greeting/
│       └── index.ts           # enabled by greeting: {} in the config
├── hooks/
│   └── authorized.ts          # the @authorized tag
├── jobs/                      # scheduled jobs, optional
├── migrations/                # SQLite, PostgreSQL and MongoDB only
├── package.json
├── quickservicets.config.ts
└── tsconfig.json
```

## `entities/`

One entity per file, named like its type: `entities/User.ts` exports `User`. Each entity gets its generated routes and a repository.

- **A subfolder is a database schema.** `entities/auth/Account.ts` belongs to the `auth` schema and is served at `/auth/accounts`. Only one level of folders is allowed.
- **Shared enums can live here too.** A file that exports only enums or string unions is not an entity; entities import from it.

[Your first entity](/getting-started/first-entity/) walks through one, and the [JSDoc tags reference](/reference/tags/) lists every rule you can add.

## `endpoints/`

Your own routes, one file per route. The folders are the path and the file name is the method (`get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts` or `options.ts`). A folder in brackets, like `[id]`, is a path parameter.

```ts title="endpoints/health/get.ts"
import type { Endpoint } from "@quickservicets/core";

/**
 * @summary Health check
 * @authorized
 */
const handler: Endpoint<unknown, { ok: boolean }> = async () => {
  return { ok: true };
};

export default handler;
```

An endpoint receives the repositories, the request and the response controls, and returns the response body. A file with the same method and path as a generated route, such as `endpoints/users/[id]/get.ts`, replaces that route.

## `hooks/`

Code that runs before or after a route. The file name is the hook's name, and you apply it by tagging an entity or an endpoint with it, like `@authorized` above.

```ts title="hooks/authorized.ts"
import { definePreHook, HttpError } from "@quickservicets/core";

export default definePreHook(async (_repos, req) => {
  if (!req.headers.get("authorization")) throw new HttpError(401, "Missing credentials");
});
```

With this hook, a request without the header is stopped before the endpoint runs:

```bash
curl localhost:3000/health
```

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Missing credentials" } }
```

And one with it gets through:

```bash
curl -H "authorization: Bearer token" localhost:3000/health
```

```json
{ "ok": true }
```

## `features/`

Features of your own, one folder per feature: `features/greeting/index.ts` default-exports `defineFeature({ key: "greeting", ... })`, and `greeting: {}` in the config turns it on. A feature can add entities, endpoints, hooks, jobs, tags, commands and code that runs when the server starts, with the same contract as the framework's native features; one with the key of a native replaces it. The [Project features](/guides/project-features/) guide covers each part.

Features may also give the project new convention folders, like `queues/` or `greetings/`: the feature declares the folder, and the build reads every file in it, the way it reads `entities/`. Such a folder appears only when a feature that declares it is enabled.

## `quickservicets.config.ts`

The project configuration: the database, plus optional settings for the server, files, storage, populate depth, migrations and the API docs.

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
});
```

Every key is in the [configuration reference](/reference/config/).

## `.env`

Environment variables, such as `DATABASE_URL` or `PORT`. Bun loads this file by itself, and the config reads the values through `process.env`. Keep it out of version control; `init` already lists it in `.gitignore`.

## `migrations/`

Created by `quickservicets migration add <Name>`, one file per migration (`<timestamp>_<Name>.ts`) plus a `meta/` folder with the model snapshots. You apply them with `quickservicets migrate`. The memory database has no migrations, so this folder does not appear in `my-api`. See the [CLI reference](/reference/cli/).

## `.generated/`

Everything `build` (and `dev`) produces. Each build updates it in place and deletes files it no longer generates.

| File | Contains |
| --- | --- |
| `models.ts` | The parsed entities the runtime uses |
| `types.ts` | One type per entity, plus its `Create` and `Update` types and the typed `Repositories` |
| `routes.ts` | The generated CRUD routes, your endpoints and their hooks |
| `openapi.json` | The OpenAPI document served at `/openapi.json` and `/docs` |
| `server.ts` | The entry that starts the server: `bun .generated/server.ts` |

Never edit these files; the next build overwrites them. `init` already lists `.generated/` in `.gitignore`, so they stay out of git.

The `Repositories` type is what gives `repos.users` its types in endpoints and hooks. The [Repositories and queries reference](/reference/api/) covers its methods.

## Other files

- **`package.json`** has the two framework dependencies, `@types/bun` and `typescript` as dev dependencies, and the `dev`, `build`, `migrate`, `start` and `typecheck` scripts. `bun run typecheck` runs `tsc --noEmit`; run `bun run build` first so the generated types exist.
- **`tsconfig.json`** uses the Bun types (`"types": ["bun"]`, for `Bun` and `process`) and includes every convention folder (`entities`, `endpoints`, `hooks`, `jobs`, `features`, `migrations`, `lib` and `tests`), the config file and `.generated/**/*.ts`, so your editor checks all your code and sees the generated types. TypeScript skips folders whose name starts with a dot unless a pattern names their files.
- **`uploads/`** appears once someone uploads a file: it is the default local storage for `File` and `Media` records. `init` lists it in `.gitignore` too.
- With SQLite, the database file (`data.db` by default) sits in the project folder too, and is also in `.gitignore`.

## Next

You have a running API and know your way around the project. Continue with the [Tutorial](/tutorial/), which builds a complete example step by step.
