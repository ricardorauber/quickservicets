---
title: Configuration and logging
description: The config file, database adapters, environment variables, and request logs.
sidebar:
  order: 43
---

A project has one configuration file, `quickservicets.config.ts`, at its root. The CLI reads it for `build`, `dev` and the migration commands, and the server reads it when it starts. Most settings have defaults, so a config often holds just the database.

## `quickservicets.config.ts`

The file default-exports the result of `defineConfig`. `defineConfig` returns its argument unchanged; it is there so your editor types and completes every key:

```ts check title="quickservicets.config.ts"
import { defineConfig, postgresAdapter } from "@quickservicets/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
  server: { publicUrl: "https://api.example.com" },
  files: { maxSize: "20MB" },
  populate: { maxDepth: 3 },
});
```

`database` is the only required key. Invalid values stop the CLI and the server with a message naming the key, for example `Invalid server.port: expected an integer between 1 and 65535, got 70000`. Every key, with its type and default, is in the [Configuration reference](/reference/config/).

The config is TypeScript, so it can read environment variables, branch on them, or import helpers. The server resolves it when it starts, not at build time, so one build runs in every environment.

## Database adapters

`database` takes one of four adapters, all exported by `@quickservicets/core`:

```ts check
import { memoryAdapter, mongodbAdapter, postgresAdapter, sqliteAdapter } from "@quickservicets/core";

// Records live in memory and disappear on restart; no migrations.
export const memory = memoryAdapter();

// A SQLite file (created when missing), or ":memory:".
export const sqlite = sqliteAdapter({ path: process.env.DATABASE_PATH! });

// PostgreSQL, through Bun's SQL client.
export const postgres = postgresAdapter({ url: process.env.DATABASE_URL! });

// MongoDB; it must run as a replica set, because relation updates use transactions.
export const mongodb = mongodbAdapter({ url: process.env.DATABASE_URL!, database: process.env.DATABASE_NAME! });
```

`quickservicets init --db <database>` writes the matching config and a `.env` with the variables it reads.

`postgresAdapter` opens up to 10 connections; `max` changes that. The total holds across all the server's workers (see below).

## Using every CPU

A server is one process, so it uses one CPU. `server.workers` starts several processes that share the port:

```ts check title="quickservicets.config.ts"
import { defineConfig, postgresAdapter } from "@quickservicets/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL!, max: 10 }),
  server: { workers: "auto" },
});
```

`workers` is a positive integer or `"auto"`, the number of CPUs available to the process. On Linux, `"auto"` reads the container's CPU quota (cgroup v2 `cpu.max`), so a container started with `--cpus=2` runs 2 workers on any host. The `QS_WORKERS` variable overrides the config.

Without a value, a service in production mode (`NODE_ENV=production`, or `production: true`) on Linux with PostgreSQL or MongoDB uses `"auto"`, so a deployed container uses every CPU it is given with no setting at all. Everywhere else the default is 1: in development, on macOS (where `reusePort` does not spread connections across processes) and with the memory and SQLite adapters. Set `workers: 1` or `QS_WORKERS=1` to keep a single process in production.

With more than one worker:

- The process started by `bun .generated/server.ts` only supervises. It starts the workers, which listen on the port with `reusePort`, and starts a worker again when it exits.
- `SIGTERM` and `SIGINT` go to every worker, and each one shuts down gracefully, letting its running jobs finish (see [Jobs](/guides/jobs/)). The process exits once all have stopped, with 0, or 1 when a worker failed.
- The connection pool is divided across the workers, rounded up: with `max: 10` and 2 workers each one opens up to 5.
- Scheduled jobs, the run cleanup and the abandoned-run check run in the first worker only. `req.jobs.run` works in every worker.
- Each worker has `QS_WORKER_INDEX`, from `0` to `workers - 1`, in its environment.

Workers need a database server. The memory and SQLite adapters keep their data in the process, so the server refuses to start:

```text
server.workers > 1 requires a database server (PostgreSQL or MongoDB)
```

The operating system spreads connections across the workers only on Linux. On macOS the workers start, but one of them receives the requests, so keep the default of 1 there. Module-level state, such as an in-memory cache, is separate in each worker, and log lines from all of them share stdout.

## Environment variables

Bun loads `.env` from the project folder, so values there reach `process.env` in the config. `init` adds `.env` to `.gitignore`; keep secrets there or in your host's settings. The [Environment](/guides/environment/) guide shows how to declare the variables a service needs with types, check them at startup and with `quickservicets env check`, and keep secrets out of logs.

| Variable | Read by | Effect |
| --- | --- | --- |
| `DATABASE_URL` | the config written by `init` | Connection URL for PostgreSQL and MongoDB. |
| `DATABASE_NAME` | the config written by `init` | MongoDB database name. |
| `DATABASE_PATH` | the config written by `init` | SQLite file path. |
| `DATABASE_SCHEMA` | QuickService.ts | Default database schema; overrides `schema` in the config. Must match `^[a-z][a-z0-9-]*$`. |
| `PORT` | QuickService.ts | Port to listen on; overrides `server.port` (default 3000). |
| `QS_WORKERS` | QuickService.ts | Number of server processes, or `auto`; overrides `server.workers`. |
| `NODE_ENV` | QuickService.ts | `production` turns on production mode, even when `production` is set in the config. |
| `FILES_SIGNING_SECRET` | QuickService.ts | Secret of signed file URLs; overrides `files.signingSecret`. |
| `QS_<KEY>` | QuickService.ts | Any config key that holds a value, named after its path: `QS_SERVER_PORT`, `QS_JOBS_RETRIES`, `QS_FILES_ACCEPT`. See below. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_ENDPOINT` | `s3Storage` | Credentials, region and endpoint left out of the options; the `AWS_*` versions also work. |

The `DATABASE_*` names other than `DATABASE_SCHEMA` are a convention of the generated config, not built in: rename them as you like. `DATABASE_SCHEMA` lets one build run against a different schema per environment:

```bash
DATABASE_SCHEMA=staging bun run quickservicets migrate
DATABASE_SCHEMA=staging bun .generated/server.ts
```

An invalid name stops the command:

```text
Invalid DATABASE_SCHEMA: "Bad" must match ^[a-z][a-z0-9-]*$
```

### Overriding any key

Every config key that holds a value can be set by a variable named `QS_` plus its path in upper snake case: `server.port` is `QS_SERVER_PORT`, `jobs.limits.logLines` is `QS_JOBS_LIMITS_LOG_LINES`. A feature's options follow the same rule under its key (`history.retention` is `QS_HISTORY_RETENTION`), and `QS_<KEY>_ENABLED=true` or `false` turns a feature on or off without editing the config. The [configuration reference](/reference/config/) lists every variable.

A variable wins over the older names above, which win over the config file, which wins over the defaults. Values are read from text: numbers, `true`/`false`/`1`/`0` for booleans, and lists as comma-separated items or a JSON array:

```bash
QS_SERVER_PORT=4000 QS_JOBS_RETRIES=2 QS_FILES_ACCEPT="image/*, application/pdf" bun .generated/server.ts
```

A value that does not fit stops the service, naming the variable and the key:

```text
Invalid QS_SERVER_PORT (server.port): expected an integer between 1 and 65535, got "abc"
```

Keys that hold code (`database`, `logger`, `storage`) are not overridable. A `QS_*` variable that matches no key is not an error, since environments are often shared; the server logs it once at startup and `quickservicets build` prints it as a warning, with the closest name:

```text
Warning: Unknown environment variable QS_SERVR_PORT (did you mean QS_SERVER_PORT?)
```

### Production mode

`production` defaults to `false`, and `NODE_ENV=production` turns it on. In production:

- 500 responses hide the error details. In development they include the stack:

```bash
curl localhost:3000/boom
```

```json
// 500 Internal Server Error, development
{"error":{"code":"INTERNAL_ERROR","message":"Internal server error","details":{"stack":"Error: Something broke\n    at handler (.../endpoints/boom/get.ts:2:13)\n    ..."}}}

// 500 Internal Server Error, production
{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}
```

- The [API docs](/guides/api-docs/) are off unless `docs.enabled` is `true`.
- `migrate` refuses to revert migrations without `--force` (see [Migrations](/guides/migrations/)).

## Logging

The server writes one log entry per request, as a JSON line on stdout:

```json
{"level":"info","timestamp":"2026-10-16T22:25:19.256Z","requestId":"01a146d1-d595-77ea-8f13-a6c875a44b64","method":"DELETE","route":"/organizations/[id]","status":204,"durationMs":2.82,"hooks":[]}
```

| Key | Description |
| --- | --- |
| `level` | `info` for statuses below 500, `error` for 500 and above. |
| `timestamp` | ISO 8601 time of the entry. |
| `requestId` | The request id (see below). |
| `method` | HTTP method. |
| `route` | The matched route pattern, such as `/users/[id]`, or `null` when no route matched. |
| `status` | Response status. |
| `durationMs` | Time to produce the response. |
| `hooks` | Names of the hooks that ran. |

Entries never contain bodies, query values, path parameter values or headers other than the request id, so they are safe to ship to a log service.

The default logger collects the lines of one event-loop turn and writes them to stdout together, at the end of the turn or as soon as they pass 64 KB, instead of one write per request. The lines and their order do not change. `error` entries are written right away, and the buffer is written when the process exits and on a graceful shutdown (`SIGTERM` or `SIGINT`), so no line is lost when the server stops. A process killed with `SIGKILL` can lose the lines of its last turn.

Two other kinds of entries exist. An unexpected error (anything thrown that is not an `HttpError`) is logged at `error` with its name, message and stack, in every mode, before the request's entry:

```json
{"level":"error","timestamp":"2026-10-16T22:37:22.964Z","requestId":"01a146dc-e094-7726-97ee-a516e0382876","error":{"name":"Error","message":"Something broke","stack":"Error: Something broke\n    at handler (.../endpoints/boom/get.ts:2:13)\n    ..."}}
```

And a stored file that could not be deleted is logged at `warn` with `message: "File object not deleted"`, the `storage`, the `key` and the `error` (see [Files and storage](/guides/files/#cleanup)).

### Request ids

Every response has an `x-request-id` header with the id that appears in the logs, and handlers and hooks read it as `req.id`. When the request sends an `x-request-id` made of 1 to 128 letters, digits, `_` or `-`, the server keeps it; otherwise it generates a UUID v7. Pass the id from your gateway or frontend to follow one request across services (`/health` is the endpoint from [API docs](/guides/api-docs/#custom-endpoints)):

```bash
curl -i -H 'x-request-id: checkout-42' "localhost:3000/health?verbose=true"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
x-request-id: checkout-42
Content-Length: 33

{"status":"ok","uptimeSeconds":2}
```

```json
{"level":"info","timestamp":"2026-10-16T22:37:22.936Z","requestId":"checkout-42","method":"GET","route":"/health","status":200,"durationMs":0.723,"hooks":[]}
```

### A custom logger

`logger` takes any object with `info`, `warn` and `error` methods, each receiving the entry as an object. Send entries to your log library, or add fields to them. This config adds the service name and keeps the JSON lines of the default `jsonLogger`:

```ts check
import { defineConfig, jsonLogger, sqliteAdapter, type Logger } from "@quickservicets/core";

const logger: Logger = {
  info: (entry) => jsonLogger.info({ service: "accounts", ...entry }),
  warn: (entry) => jsonLogger.warn({ service: "accounts", ...entry }),
  error: (entry) => jsonLogger.error({ service: "accounts", ...entry }),
};

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  logger,
});
```

```json
{"level":"info","service":"accounts","timestamp":"2026-10-16T22:37:22.974Z","requestId":"01a146dc-e09e-71d8-b329-7c5e571e7ca7","method":"GET","route":"/users/[id]","status":401,"durationMs":0.377,"hooks":["authorized"]}
```

An error thrown by the logger never changes the response.

## See also

- [Configuration reference](/reference/config/): every key with its type and default.
- [CLI](/reference/cli/): the commands that read the config.
- [Environment](/guides/environment/): typed variables, `QS_*` overrides and their precedence.
- [Events](/guides/events/): the `events` key, for write events, listeners, the outbox and durable consumers.
- [Security](/guides/security/): the `security` key, on by default: security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists and log masking.
- [Queues](/guides/queues/): the `queues` key, for background work in the project's database with retries, dead letters, dedupe and `@publish`.
- [Health checks](/guides/health/): the `health` key, for liveness and readiness routes and draining on shutdown.
- [Idempotency keys](/guides/idempotency/): the `idempotency` key, for safe retries of `POST` requests.
- [Optimistic concurrency](/guides/optimistic-concurrency/): the `etag` key, for entity tags, 304 answers and `If-Match`.
- [Entity history](/guides/history/): the `history` key, for every version of chosen records, its routes and its retention.
- [Server-Sent Events](/guides/server-sent-events/): the `realtime` key, for `sse.ts` endpoints and live change streams.
- [WebSockets](/guides/websockets/): the `realtime` key, for `ws.ts` endpoints with typed messages, rooms and delivery across workers and replicas.
- [Error reporting](/guides/error-reporting/): the `errors` key, for reporting every unexpected error to a reporter.
- [Feature flags](/guides/feature-flags/): the `flags` key, for turning features on per user, tenant or percentage.
- [Multi-tenancy](/guides/multi-tenancy/): the `tenancy` key, for serving many tenants from one service, each in a schema or a database of its own.
- [Authentication](/guides/authentication/): the `auth` key, for one authentication contract, `@auth` and `@roles`, OpenAPI security, the account protection kit and CSRF for cookie sessions.
- [Usage metrics](/guides/usage-metrics/): the `metrics` key, for requests, errors and latency per route, tenant and user, served at `/_metrics` as JSON and for Prometheus.
- [API gateway](/guides/api-gateway/): the `proxy` key, for forwarding path prefixes to other services with rewriting, authentication, signed identity headers and security per route.
- [mTLS](/guides/mtls/): `server.tls` and the `security.mtls` item, for HTTPS from the service, client certificates, forwarded identities and certificates for outgoing calls.
- [HTTP client](/guides/http-client/): the `http` key, on by default: outgoing calls with SSRF protection, named services, retries, circuit breakers, caching and mocks.

Next: [Jobs](/guides/jobs/).
