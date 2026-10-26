# Config and environment

How to configure a project in `quickservicets.config.ts`, `.env` and `QS_*` variables, and check an environment.

## The config file

`quickservicets.config.ts` default-exports `defineConfig({ ... })`. Only `database` is required:

```ts
// quickservicets.config.ts
import { defineConfig, integer, secret, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  server: { port: 3000 },
  env: {
    STRIPE_KEY: secret().describe("The Stripe secret key."),
    REPORT_HOUR: integer().min(0).max(23).default(6),
  },
});
```

Adapters: `memoryAdapter()`, `sqliteAdapter({ path })`, `postgresAdapter({ url })` and `mongodbAdapter({ url, database })` (MongoDB must run as a replica set). After changing the database, rebuild and create a migration.

## `.env`

Bun loads `.env` from the project folder; the config reads it through `process.env`. `init` writes `DATABASE_PATH=data.db` for SQLite, `DATABASE_URL` for PostgreSQL, and `DATABASE_URL` and `DATABASE_NAME` for MongoDB. `PORT` sets the port. Keep `.env` out of git (`init` already lists it in `.gitignore`).

## Typed variables

Declare the variables the service needs under `env` with option schemas (`string()`, `integer()`, `boolean()`, `url()`, `secret()`, `oneOf([...])`, with `.default(...)` or `.optional()`). The service refuses to start when one is missing or invalid, listing every problem. Read them typed with `env` from `@quickservicets/core`:

```ts
// lib/report.ts
import { env } from "@quickservicets/core";

export const reportHour = (): number => env.REPORT_HOUR;
```

Check an environment without starting the service:

```bash
bun run quickservicets env check
```

It prints one line per variable with `ok`, `default`, `missing` or `invalid` and exits with 1 when one is missing or invalid; secrets are never printed. The build writes `.env.example` with every declared variable.

## `QS_*` overrides

Every config key that holds a value can be set by `QS_` plus its path in upper snake case, which wins over the config file:

- `server.port` is `QS_SERVER_PORT` (`PORT` also works), `server.workers` is `QS_SERVER_WORKERS` (or `QS_WORKERS`).
- `repositories.toArrayMax` is `QS_REPOSITORIES_TO_ARRAY_MAX`.
- A feature's options use its key: `security.rateLimit.limit` is `QS_SECURITY_RATE_LIMIT_LIMIT`, `queues.retries` is `QS_QUEUES_RETRIES`.
- `QS_QUEUES_ENABLED=true` turns a feature on, and `QS_SECURITY_ENABLED=false` turns one off, without editing the config.

Lists are comma-separated or a JSON array; booleans are `true`, `false`, `1` or `0`. Keys that hold code (`database`, `logger`, `storage`) are not overridable. A `QS_*` name that matches no key is a warning with the closest name, not an error.

## Production mode

`NODE_ENV=production` (or `production: true`) hides error details in 500 responses, turns the API docs off unless `docs.enabled` is `true`, and makes `migrate` refuse to revert without `--force`.

Full docs: [Configuration](/guides/configuration/), [Environment](/guides/environment/) and the [configuration reference](/reference/config/).

## Do not

- Do not give the config file another name; it is `quickservicets.config.ts` at the project root.
- Do not commit `.env` or put secrets in the config file; read them from the environment.
- Do not declare your own variables with a `QS_` prefix; those names are reserved for overrides.
- Do not read `process.env` all over the code for declared variables; use `env`.
- Do not try to override `database`, `logger` or `storage` with a variable.
