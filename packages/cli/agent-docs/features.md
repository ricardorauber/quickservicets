# Features

The native features (security, events, queues, health, idempotency, etag, history, realtime, errors, flags, http) and how to turn them on, off and customize them.

Natives ship inside `@quickservicets/core`; nothing extra is installed. `security` and `http` are on by default; every other native is off until you turn it on.

| Key | What it does | Tags and commands |
| --- | --- | --- |
| `security` | Security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists, log masking | `@rateLimit`, `@cors`, `@limits`, `@ipAllow`, `@ipDeny`, `@securityHeaders`, `@sensitive` |
| `events` | Write events for every entity, `events.on(...)` listeners, files in `events/`, a transactional outbox | `@events`; `quickservicets events outbox` |
| `queues` | Background queues in the project's database, consumers as files in `queues/` | `@publish`; `quickservicets queue list` |
| `health` | `/health/live` and `/health/ready` routes | |
| `idempotency` | `Idempotency-Key` replays for repeated writes | `@idempotent` |
| `etag` | `ETag`, 304 on conditional reads, 412 on stale writes | `@etag` |
| `history` | Every version of tagged records, with history routes | `@history`; `quickservicets history prune` |
| `realtime` | Server-Sent Events from `sse.ts` files and change streams | `@changes` |
| `errors` | One reporter interface for every unexpected error | `@report` |
| `flags` | Feature flags per user, tenant or percentage, `req.flags` | `@flag`; `quickservicets flags list` |
| `http` | The outgoing HTTP client `http.get(url).send()`, with timeouts, size limits, SSRF protection (`http.allow` for internal hosts) and clear errors (502 or 504 when one escapes) | |

## Turn one on

Add its key to the config, with `{}` for the defaults or with options, then rebuild:

```ts
// quickservicets.config.ts
import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  events: {},
  queues: {},
  history: { retention: "90d" },
  security: { cors: { origins: ["https://app.example.com"] } },
});
```

```bash
bun run build
bun run quickservicets migration add EnableQueuesAndHistory
bun run quickservicets migrate
```

Some natives need others: `history` needs `events`, and the build fails with `history requires events; add events: {} to quickservicets.config.ts` until you add it. Natives that store data (queues, history, the events outbox, flags with `source: "database"`) add tables, so they need a migration like any entity change. Without the key in the config, `QS_<KEY>_ENABLED=true` turns a native on, like `QS_QUEUES_ENABLED=true`.

## Turn one off

- In the config: `security: false`, or one item: `security: { rateLimit: { enabled: false } }`.
- From the environment: `QS_SECURITY_ENABLED=false`.
- For one route or entity: the tag with `off`, like `@rateLimit off`.

## Customize

Each native can be changed at every level, from the lightest to the deepest:

1. Options in the config, like `security.rateLimit.limit` or `queues.retries`.
2. `QS_*` variables for each option, like `QS_QUEUES_RETRIES=5` (see the `config-and-env` topic).
3. Tags on one entity, field or route, like `@rateLimit 10/min by=user` or `@history`.
4. Hooks in the options, like `queues.onDead` or `security.rateLimit.onLimited`, written as functions in the config.
5. Replacing one part with an implementation, like `queues.broker` or `security.rateLimit.store`.
6. `bun run quickservicets eject <key>` copies the whole native into `features/<key>/`, or `--file <path>` one file, and your copy replaces it.

```ts
// entities/Invoice.ts
/**
 * @history
 * @rateLimit 20/min
 */
export type Invoice = { number: string; total: number };
```

A tag of a native that is not on fails the build with `@history needs history, which is not enabled; add history: {} to quickservicets.config.ts`.

## Project features

Your own feature lives in `features/<key>/index.ts`, default-exporting `defineFeature({ key, options, ... })`, and is turned on with `<key>: {}`. It can add entities, endpoints, hooks, jobs, tags and commands. A project feature with the key of a native replaces the native.

Full docs: [Native features](/reference/features/); per feature, the guides like [Security](/guides/security/) and [Queues](/guides/queues/), and [Project features](/guides/project-features/).

## Do not

- Do not install a package for a native feature; they are in `@quickservicets/core`.
- Do not use a native's tag before turning the native on.
- Do not forget the migration after turning on a native that stores data.
- Do not copy a native's code by hand; use `quickservicets eject`.
- Do not turn `security` off to make a test pass; set the option or tag you need.
