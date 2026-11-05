# Features

The native features (security, events, queues, health, idempotency, etag, history, realtime, errors, flags, http, tenancy, auth, metrics, proxy, secrets, webhooks, dev, deploy, connections, triggers) and how to turn them on, off and customize them.

Natives ship inside `@quickservicets/core`; nothing extra is installed. `security`, `http`, `dev`, `deploy` and `connections` are on by default; every other native is off until you turn it on.

| Key | What it does | Tags and commands |
| --- | --- | --- |
| `security` | Security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists, log masking; `ip.source` (an `IpListSource` with `load()` and optional `watch()`, like `databaseIpList({ entity: "IpRule" })` over an entity with `cidr`, `list`, `expiresAt?`) adds runtime allow and deny entries, loaded at startup, every `ip.refresh` and on writes, and `ctx.feature("security").ip.reload()` reloads now; `ipBlocks.block(ip | cidr, { for: "15m", reason })`, `unblock` and `blocked()` (also on `ctx.feature("security").ip`) make temporary 403 blocks, in memory or shared through the `IpBlock` entity with `ip.blocks.store: "database"`; `ip.autoBlock: true` blocks an address for 15 minutes after 20 answers of 401, 403 or 429 within a minute, never loopback, allow-listed addresses or paths exempted from `ip`; hooks `ip.onBlock` and `ip.onUnblock`; `mtls` (off by default, needs `server.tls`) asks callers for client certificates checked against `mtls.ca`, gives `req.client` and admits the `mtls.allow` identities (`CN=`, `dns:`, `uri:` with SPIFFE prefixes, `sha256:`); `mtls.forwarded` reads the identity a trusted proxy or mesh forwarded in `x-forwarded-client-cert` (Envoy XFCC, or a URL-encoded PEM) instead, without `server.tls`; `mtls.allow` may be a function of `{ req, client, tenant }`, `mtls.beforeClient` and `mtls.onRejected` hook verification and refusals, `mtls.verifier` adds revocation or SPIFFE checks, and `certificateAuth({ user })` makes certificates users for `@auth` and `@roles` (guide: `/guides/mtls/`) | `@rateLimit`, `@cors`, `@limits`, `@ipAllow`, `@ipDeny`, `@securityHeaders`, `@sensitive`, `@mtls` |
| `events` | Write events for every entity, `events.on(...)` listeners, files in `events/`, a transactional outbox | `@events`; `quickservicets events outbox` |
| `queues` | Background queues in the project's database, consumers as files in `queues/`; external brokers use the broker kit (guide: queues) | `@publish`; `quickservicets queue list` |
| `health` | `/health/live` and `/health/ready` routes | |
| `idempotency` | `Idempotency-Key` replays for repeated writes | `@idempotent` |
| `etag` | `ETag`, 304 on conditional reads, 412 on stale writes | `@etag` |
| `history` | Every version of tagged records, with history routes | `@history`; `quickservicets history prune` |
| `realtime` | Server-Sent Events from `sse.ts` files and change streams; WebSockets from `ws.ts` files written with `defineSocket` (typed with `defineSocket<{ in; out }>`, validated and routed by `type` with `on`), rooms with `ws.subscribe` and `sockets.publish(room, data)` from any code, delivered across workers by `websockets.transport` (`"postgres"` uses LISTEN and NOTIFY); hooks `beforeConnect`, `beforeMessage`, `beforeSubscribe`, `beforePublish`, `afterConnect`, `onClose`; `ctx.feature("realtime").socket(path, defineSocket(...), options?)` adds socket routes at runtime | `@changes`, `@socket` |
| `errors` | One reporter interface for every unexpected error | `@report` |
| `flags` | Feature flags per user, tenant or percentage, `req.flags`; providers may `prepare({ user, tenant, req })` per request; `flags.evaluate(name, { user, tenant })` resolves outside requests | `@flag`; `quickservicets flags list` |
| `http` | The outgoing HTTP client `http.get(url).send()`, with timeouts, size limits, SSRF protection (`http.allow` for internal hosts) and clear errors (502 or 504 when one escapes); `http.services.<name>.tls` (`cert`, `key`, `ca`, `serverName`) presents a client certificate to services that require mTLS, reloaded when its files change; handshake failures fail with code `TLS` | |
| `tenancy` | The tenant of every request in `req.tenant.id`, from the `x-tenant-id` header (or a subdomain, a path prefix, the credentials or a function); 400 without one | `@tenancy` |
| `auth` | One authentication contract: providers in `auth.providers` or registered by features fill `req.user`, `req.auth` and optionally `req.tenant`; 401 for invalid credentials or a missing user, 403 for a missing role or scope; `requireUser(req)` and `requireRole(req, ...roles)` in custom code; `loginGuard`, `invalidCredentials`, `dummyPasswordCheck` and `sessionStore` for providers' sign-in; `ctx.feature("auth").revoke({ userId })`; hooks `beforeUser`, `beforeAuthorize`, `onAuthenticated`, `onAuthFailed`; `testAuth()` for tests | `@auth`, `@roles` |
| `metrics` | API usage kept by the service: requests, errors (5xx), client errors (4xx) and p50, p95 and p99 latency per route and tenant (`by` adds `user`) in one-minute windows rolled into hours; `store: "database"` shares them across workers and replicas (needs a migration); `GET /_metrics` answers JSON or, with `?format=prometheus`, the Prometheus text format, from loopback and private addresses (`access.token` for a bearer token); `ctx.feature("metrics").query(...)` and `queryMetrics(...)`; `record` per request; hooks `beforeRecord`, `onWindowClosed`; a `MetricsStore` replaces the store; features add usage counters with `ctx.feature("metrics").usage(name, { unit, description }).add(value)` | `@metrics` |
| `proxy` | An API gateway: `proxy.routes.<name>` with `path` (`/billing/*`) and `target` (a URL) or `service` (an `http.services` entry) forwards requests streaming both ways, with `x-forwarded-*` headers and the upstream's `host`, never `cookie`, `authorization` or hop-by-hop headers; `timeout` until headers (504), `idleTimeout` between chunks, 502 for connection failures and 503 for an open circuit; `stripPrefix` or `rewrite: "/api/v2/[...rest]"` change the upstream path; `auth: "required"`, `roles` and `scopes` check the user first (401, 403); the client's `x-user-id`, `x-user-roles` and `x-tenant-id` never pass, `forward` (default `["user", "tenant"]`) sends the real ones; `identity.secret` signs them and `proxyIdentity({ secret })` verifies them in the upstream; per-route `rateLimit`, `cors` (answered by the gateway), `ip` and `maxBodySize` (413) go through `ctx.feature("security").routeOptions(pattern, options)`, which any feature can call for routes without a file to tag; a target function with `allowedTargets` chooses the upstream per request; hooks `beforeProxy`, `afterProxy`, `onProxyError`; `forward(req, "orders", overrides?)` from any endpoint, hook or feature handler forwards with a route's settings, and `forward(req, { service | target, path | stripPrefix | rewrite, timeout, headers })` without a route (`proxy: {}` is enough; an inline `target` must be in `proxy.allowedTargets`, else 502), resolving the upstream `Response` for every status and rejecting with the 502/503/504 `HttpError` (`proxyRequest` is its alias); a `forwarder` replaces the calls; `websocket: true` on a route (needs `realtime: {}`) proxies WebSocket upgrades to `ws://`/`wss://` after the same checks plus the `realtime.websockets` origin and `maxConnections` checks, upgrading the client only after the upstream handshake (502 refused, 504 past `timeout`), piping frames with the `maxMessageSize` (1009) and `idleTimeout` (1001) limits, passing close codes and closing with 1014 when the upstream drops; a project endpoint on the same or a more specific path wins | |
| `secrets` | Secret references in the configuration: `secret("<scheme>://<path>[#<key>][?version=<version>]")` as the value of any `secret()` option, `server.tls.cert`, `key`, `passphrase`, `files.signingSecret` or `postgresAdapter({ url })` / `mongodbAdapter({ url })`, and a declared `secret()` variable whose text starts with a registered scheme and `://` (`STRIPE_KEY=file:///run/secrets/stripe`); built-in `env://NAME` and `file://<path>` (one trailing line break removed), `#key` reads a JSON property; resolved once at startup, after the native and the features that list `secrets` in `requires` or `enables` set up and before the others and the database connection, each text once, with `timeout` (10s) per attempt and `retries` (2); failures stop startup with `Cannot resolve secrets:` and one line `<path>: <reference> (<reason>)` each, never a value; values are masked as `[secret]`; a feature registers providers with `ctx.feature("secrets").provider({ schemes, resolve })`; a reference with the native off fails `<path> uses <reference>; add secrets: {} to quickservicets.config.ts`; values are re-resolved in the background every `refresh` (1m) once due at the provider's `ttl`, two thirds of its `expiresAt`, or the `ttl` option (15m), and a changed value replaces the old one in the config, options, `env` and `secretValue` (both stay masked), runs `onRotate` hooks with `{ path, reference, version }`, emits `secret.rotated` with events on and logs `message: "secrets.rotated"`; the HTTP client reads service `auth` per call, the PostgreSQL and MongoDB adapters open new connections with a rotated URL while open ones finish, and a rotated `server.tls` cert or key reaches new connections; a failed refresh keeps the value and logs `message: "secrets.refresh.failed"` once a minute (`onRefreshError: "fail"` also fails readiness), a passed lease logs `message: "secrets.expired"`, and with `health` on the check `secrets` lists failing paths; `secrets.get("<reference>")` and `secrets.onRotate(reference, fn)` from `@quickservicets/core` read other references at runtime through the same cache; a reference with `{tenant}` in its path or key (`secret("vault://kv/tenants/{tenant}/db#url")`) resolves per tenant on first use, after checking the id against the tenant id rule, in `tenancy.connection`, a tenant's `connection`, `secrets.forTenant(id).get(reference)` and `req.secrets.get(reference)`, and fails startup anywhere else with `<path> uses {tenant}, which only works for tenant connections, tenant entries and secrets.forTenant()`; each worker keeps `tenantCacheSize` (10000) per-tenant values, least recently used evicted, refreshing only the ones read; a failure fails only that tenant (503 for its database), logs `message: "secrets.tenant.failed"` and is not retried for 10 seconds; providers are `defineSecretProvider({ name, schemes, resolve, health?, close?, transport? })`, resolving `{ value }` or `{ values }` (the core applies `#key`), throwing `SecretNotFoundError` or `SecretAccessError` (never retried), honoring `signal` and `?version=`; `testSecretProvider(entries)` (with `set`, `fail` and `calls`) and `runSecretProviderContract(create, { fixtures })` come from `@quickservicets/core/testing`; `secrets.providers` registers project providers, `secrets.beforeResolve` may return another reference (an environment prefix), `secrets.onResolveFailed` gets `{ reference, path, tenant?, reason }`, and `quickservicets secrets check [--tenant <id>]` resolves every reference before a deploy, printing `<path> <reference> ok version <n>` or `failed: <reason>` per line and exiting 1 on a failure; the native has no tags and no files (guide: `/guides/secrets/`) | |
| `webhooks` | Signed outgoing webhooks and incoming `webhook.ts` endpoints; `webhooks: {}` turns on `events` and `queues`. Deliverable: write events of entities tagged `@webhooks` (`@webhooks created,updated fields=a,b`) and events matching `webhooks.events` (`invoice.*`). Subscriptions (`WebhookSubscription`): `webhooks.subscriptions.create({ url, events })` returns the `whsec_` secret once, plus CRUD, `rotateSecret` and `ping`; with `auth`, routes under `/webhooks` for `routes.roles`, scoped to the tenant. Attempts are Standard Webhooks signed (`webhook-id`, `webhook-timestamp`, `webhook-signature`; `signWebhook`/`verifyWebhook`), retried on `delivery.retrySchedule`, and a subscription failing for `delivery.disableAfter` (`5d`) or answering 410 is disabled; delivery is at least once, so receivers deduplicate by `webhook-id`; log and resend at `/webhooks/[id]/deliveries`. Incoming: `defineWebhook({ verify: stripeSignature|githubSignature|standardWebhookSignature|hmacSignature(...), handle, async? })` checks the raw body (401 `INVALID_SIGNATURE`), deduplicates by delivery id and may run `handle` on a queue. Hooks around delivery and handling; `sender` replaces sending (guide: `/guides/webhooks/`) | `@webhooks`, `@webhook`; `quickservicets webhooks list`, `webhooks deliveries`, `webhooks resend` |
| `dev` | Local services: `quickservicets dev --services` writes `.generated/dev/compose.yml` from `describeInfrastructure(config)` (the PostgreSQL or MongoDB databases, MinIO for an S3 storage without `endpoint`, and each feature's `infra`), starts it with `docker compose up -d --wait`, and passes the connection variables `.env` does not set to the server; `dev.services.<name>.port`, `.image`, `.enabled`; `dev/compose.override.yml` is a second compose file; refused in production (guide: `/guides/local-environment/`) | `quickservicets services up`, `down [--volumes]`, `status`, `logs [name]`, `env [--show]` |
| `deploy` | Deploy targets: `quickservicets build --target server|binary|lambda|azure-functions|cloud-run` (or `QS_DEPLOY_TARGET`, `deploy.target`) writes `dist/<target>/` and prints `Target <target>: dist/<target>/ (<size>)`; `lambda` and `azure-functions` run as functions (no scheduler, no consumer loops, no `ws.ts`), and the build warns for each job and database queue the platform must drive (guide: `/guides/deploy-targets/`) | `build --target` |
| `connections` | Pool sizes for servers and functions: `mode` auto (serverless on lambda and azure-functions: `max` 2, `idleTimeout` 30s, `maxLifetime` 15m, `connectTimeout` 5s, `lazy`), `budget` and `instances` warn when `max × workers × instances` exceeds the budget, `databases.<name>` per named database; a statement failing before it was sent is retried once and logged as connections.reconnected; `proxy` (`pgbouncer` or `rds-proxy`) turns prepared statements off, `rds-proxy` requires TLS, and `direct` (a URL bypassing the proxy) is used by `migrate` and by features that need a session (`needsSession`, like the PostgreSQL socket transport), which fail startup without it; `quickservicets db check` prints the version, pools and connection counts and exits 1 on a problem; after-hooks `onConnect` (`{ adapter, database, durationMs }`) and `onConnectionError` (`{ adapter, database, error, retried }`); `postgresAdapter({ url, executor })` sends every statement through a `SqlExecutor` (an HTTP driver), checked with `runSqlExecutorContract` (guide: `/guides/serverless-connections/`) | |
| `triggers` | Files in `triggers/` default-exporting `trigger({ source, handle, batch?, options? })` (named by path; `concurrency` 1, `timeout` 30s, `retries` 3, `retryDelay` 10s) react to cloud events with `{ event, events?, trigger, repos, log, signal, http, files, queue?, attempt }`, writing as `job:trigger/<name>`; sources register with `ctx.feature("triggers").source(kind, source)`; `testSource()` and `emitTrigger(name, data)` of `@quickservicets/core/testing` in tests (guide: cloud-triggers) | — |

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
