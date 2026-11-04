---
title: Native features
description: Every native feature of QuickService.ts in one table, with how to turn each one on and off, what it needs, and the customization levels they share.
sidebar:
  order: 46.5
---

Everything beyond the generated API is a native feature that ships inside `@quickservicets/core`. A native is one config key: `<key>: {}` turns it on with its defaults, an object of options configures it, and `<key>: false` or `QS_<KEY>_ENABLED=false` turns it off. `QS_<KEY>_ENABLED=true` turns one on without touching the config.

```ts
// quickservicets.config.ts
import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  events: {},
  history: { retention: "90d" },
});
```

## Every native

| Key | What it does | Enabled | Requires | Guide | Reference |
| --- | --- | --- | --- | --- | --- |
| `security` | Security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists and log masking | by default | — | [Security](/guides/security/) | [security](/reference/features/security/) |
| `events` | Write events for every entity, listeners, custom events and a transactional outbox | by its key | — | [Events](/guides/events/) | [events](/reference/features/events/) |
| `queues` | Background queues in the project's database with retries, delays, priorities, dead letters and dedupe | by its key | `@publish` needs `events` | [Queues](/guides/queues/) | [queues](/reference/features/queues/) |
| `health` | Liveness and readiness routes with checks from features, and draining on shutdown | by its key | — | [Health checks](/guides/health/) | [health](/reference/features/health/) |
| `idempotency` | `Idempotency-Key` replays, so a repeated `POST` returns the first response | by its key | — | [Idempotency keys](/guides/idempotency/) | [idempotency](/reference/features/idempotency/) |
| `etag` | Entity tags, 304 on conditional reads and 412 on stale writes | by its key | — | [Optimistic concurrency](/guides/optimistic-concurrency/) | [etag](/reference/features/etag/) |
| `history` | Every version of the records of entities tagged `@history`, with history routes and retention | by its key | `events` | [Entity history](/guides/history/) | [history](/reference/features/history/) |
| `realtime` | Server-Sent Events from `sse.ts` endpoints, live change streams of collections and WebSockets from `ws.ts` endpoints | by its key | change streams need `events`; works with `tenancy` | [Server-Sent Events](/guides/server-sent-events/), [WebSockets](/guides/websockets/) | [realtime](/reference/features/realtime/) |
| `errors` | One reporter interface for every unexpected error, with its request, user and tenant | by its key | — | [Error reporting](/guides/error-reporting/) | [errors](/reference/features/errors/) |
| `flags` | Feature flags per user, tenant or percentage, read with `req.flags` | by its key | — | [Feature flags](/guides/feature-flags/) | [flags](/reference/features/flags/) |
| `http` | The outgoing HTTP client, with SSRF protection, named services, retries, circuit breakers, caching and mocks | by default | — | [HTTP client](/guides/http-client/) | [http](/reference/features/http/) |
| `tenancy` | The tenant of every request, from a header, a subdomain, a path prefix, the credentials or a function, with shared, schema or database isolation | by its key | — (works with `queues`, `events` and `realtime`) | [Multi-tenancy](/guides/multi-tenancy/) | [tenancy](/reference/features/tenancy/) |
| `auth` | One authentication contract for every provider, filling `req.user` and `req.auth`, with `@auth`, `@roles` and CSRF for cookie sessions | by its key | — (a feature that lists it in `enables` turns it on) | [Authentication](/guides/authentication/) | [auth](/reference/features/auth/) |
| `metrics` | Requests, errors and p50, p95 and p99 latency per route, tenant and optionally user, in time windows kept by the service | by its key | — | [Usage metrics](/guides/usage-metrics/) | [metrics](/reference/features/metrics/) |
| `proxy` | An API gateway: proxy routes forwarding configured paths to an upstream URL or a named service, streaming both ways | by its key | `http`; WebSocket routes need `realtime` | [API gateway](/guides/api-gateway/) | [proxy](/reference/features/proxy/) |
| `secrets` | Secret references like `secret("vault://kv/db#url")` in the configuration, resolved at startup, cached, rotated and per tenant, with built-in `env://` and `file://` providers | by its key | — (a feature that lists it in `enables` turns it on) | [Secrets](/guides/secrets/) | [secrets](/reference/features/secrets/) |
| `webhooks` | Outgoing signed webhooks per event, managed as subscriptions, and incoming `webhook.ts` endpoints | by its key | `events` and `queues`, which it turns on (`enables`) | [Webhooks](/guides/webhooks/) | [webhooks](/reference/features/webhooks/) |
| `dev` | Local services for development: `quickservicets dev --services` starts the database and every service the features need with Docker Compose; adds nothing to a running service | by default | — | [Local environment](/guides/local-environment/) | [dev](/reference/features/dev/) |
| `deploy` | Deploy targets: `quickservicets build --target` writes the deployable output for a server, a binary, AWS Lambda, Azure Functions or Google Cloud Run; acts only at build time | by default | — | [Deploy targets](/guides/deploy-targets/) | [deploy](/reference/features/deploy/) |
| `connections` | Connection pool sizes for servers and functions: small, lazy pools on function targets, the adapters' pools on servers, with a budget warning | by default | — | [Serverless connections](/guides/serverless-connections/) | [connections](/reference/features/connections/) |

The infrastructure natives (`tenancy`, `auth`, `metrics`, `proxy`, `secrets` and the WebSocket part of `realtime`) shape how the service runs rather than what an entity does; mTLS is an item of `security` with its own [mTLS guide](/guides/mtls/).

A native that needs another fails the build until it is on, naming the fix, like `history requires events; add events: {} to quickservicets.config.ts`. Natives that store data (queues, history, the events outbox, idempotency keys, flags in the database) add tables, so they need a migration like any entity change.

## Core additions

Some additions live in the core rather than in a native, so they need no key:

- [`createFile`, `openFile` and `fileUrl`](/guides/files/#files-from-code) store, read and link files from endpoints, jobs and queue handlers, and [upload checks](/guides/files/#upload-checks) inspect every upload before it is stored.
- [`@vector` fields and `nearest()`](/guides/queries/#nearest-neighbor-queries-nearest) rank records by their distance from a vector, with pgvector on PostgreSQL.
- [Usage counters](/guides/usage-metrics/#usage-counters) of `metrics` count what each tenant or user consumes, and features add [WebSocket routes at runtime](/guides/websockets/#socket-routes-from-features).

## The customization levels

Every native can be changed at the same eight levels, from the lightest to the deepest; each example project in `examples/minimal/<key>` shows all of them for its feature:

1. **Enable**: the key with `{}`, like `queues: {}`.
2. **Options and environment**: options in the config and their `QS_*` variables, like `queues: { retries: 5 }` or `QS_QUEUES_RETRIES=5`.
3. **Tags**: one entity, field or route changes the feature, like `@rateLimit 10/min by=user` or `@history`.
4. **Per request**: options that are functions of the request, its user and tenant, like `security.rateLimit.limit: ({ user }) => (user ? "1000/min" : "60/min")`.
5. **Hooks and events**: functions around the feature's steps, like `queues.onDead` or `http.beforeRequest`.
6. **Override files**: a project file replaces one the feature ships, like `jobs/history/prune.ts`.
7. **Replace the implementation**: a provider option swaps a part, like `queues.broker` or `security.rateLimit.store`.
8. **Eject**: `quickservicets eject <key>` copies the native into `features/<key>/`, where the project owns it.

To replace a native completely, write a project feature with its key in `features/<key>/index.ts`; the [Project features](/guides/project-features/) guide shows how.

## Examples

- [examples/identity](https://github.com/ricardorauber/quickservicets/blob/main/examples/identity/README.md): organizations, users, teams and permissions on PostgreSQL, with `events`, `history`, `health`, `idempotency` and `flags`.
- [examples/saas-projects](https://github.com/ricardorauber/quickservicets/blob/main/examples/saas-projects/README.md): a multi-tenant project manager with `tenancy` per plan, `secrets`, and `queues` with the transactional outbox of `events`.
