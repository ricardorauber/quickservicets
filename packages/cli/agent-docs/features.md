# Features

The native features (security, events, queues, health, idempotency, etag, history, realtime, errors, flags, http, tenancy, auth, metrics, proxy) and how to turn them on, off and customize them.

Natives ship inside `@quickservicets/core`; nothing extra is installed. `security` and `http` are on by default; every other native is off until you turn it on.

| Key | What it does | Tags and commands |
| --- | --- | --- |
| `security` | Security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists, log masking; `mtls` (off by default, needs `server.tls`) asks callers for client certificates checked against `mtls.ca`, gives `req.client` and admits the `mtls.allow` identities (`CN=`, `dns:`, `uri:` with SPIFFE prefixes, `sha256:`); `mtls.forwarded` reads the identity a trusted proxy or mesh forwarded in `x-forwarded-client-cert` (Envoy XFCC, or a URL-encoded PEM) instead, without `server.tls`; `mtls.allow` may be a function of `{ req, client, tenant }`, `mtls.beforeClient` and `mtls.onRejected` hook verification and refusals, `mtls.verifier` adds revocation or SPIFFE checks, and `certificateAuth({ user })` makes certificates users for `@auth` and `@roles` (guide: `/guides/mtls/`) | `@rateLimit`, `@cors`, `@limits`, `@ipAllow`, `@ipDeny`, `@securityHeaders`, `@sensitive`, `@mtls` |
| `events` | Write events for every entity, `events.on(...)` listeners, files in `events/`, a transactional outbox | `@events`; `quickservicets events outbox` |
| `queues` | Background queues in the project's database, consumers as files in `queues/` | `@publish`; `quickservicets queue list` |
| `health` | `/health/live` and `/health/ready` routes | |
| `idempotency` | `Idempotency-Key` replays for repeated writes | `@idempotent` |
| `etag` | `ETag`, 304 on conditional reads, 412 on stale writes | `@etag` |
| `history` | Every version of tagged records, with history routes | `@history`; `quickservicets history prune` |
| `realtime` | Server-Sent Events from `sse.ts` files and change streams; WebSockets from `ws.ts` files written with `defineSocket` (typed with `defineSocket<{ in; out }>`, validated and routed by `type` with `on`), rooms with `ws.subscribe` and `sockets.publish(room, data)` from any code, delivered across workers by `websockets.transport` (`"postgres"` uses LISTEN and NOTIFY); hooks `beforeConnect`, `beforeMessage`, `beforeSubscribe`, `beforePublish`, `afterConnect`, `onClose` | `@changes`, `@socket` |
| `errors` | One reporter interface for every unexpected error | `@report` |
| `flags` | Feature flags per user, tenant or percentage, `req.flags` | `@flag`; `quickservicets flags list` |
| `http` | The outgoing HTTP client `http.get(url).send()`, with timeouts, size limits, SSRF protection (`http.allow` for internal hosts) and clear errors (502 or 504 when one escapes); `http.services.<name>.tls` (`cert`, `key`, `ca`, `serverName`) presents a client certificate to services that require mTLS, reloaded when its files change; handshake failures fail with code `TLS` | |
| `tenancy` | The tenant of every request in `req.tenant.id`, from the `x-tenant-id` header (or a subdomain, a path prefix, the credentials or a function); 400 without one | `@tenancy` |
| `auth` | One authentication contract: providers in `auth.providers` or registered by features fill `req.user`, `req.auth` and optionally `req.tenant`; 401 for invalid credentials or a missing user, 403 for a missing role or scope; `requireUser(req)` and `requireRole(req, ...roles)` in custom code; `loginGuard`, `invalidCredentials`, `dummyPasswordCheck` and `sessionStore` for providers' sign-in; `ctx.feature("auth").revoke({ userId })`; hooks `beforeUser`, `beforeAuthorize`, `onAuthenticated`, `onAuthFailed`; `testAuth()` for tests | `@auth`, `@roles` |
| `metrics` | API usage kept by the service: requests, errors (5xx), client errors (4xx) and p50, p95 and p99 latency per route and tenant (`by` adds `user`) in one-minute windows rolled into hours; `store: "database"` shares them across workers and replicas (needs a migration); `GET /_metrics` answers JSON or, with `?format=prometheus`, the Prometheus text format, from loopback and private addresses (`access.token` for a bearer token); `ctx.feature("metrics").query(...)` and `queryMetrics(...)`; `record` per request; hooks `beforeRecord`, `onWindowClosed`; a `MetricsStore` replaces the store | `@metrics` |
| `proxy` | An API gateway: `proxy.routes.<name>` with `path` (`/billing/*`) and `target` (a URL) or `service` (an `http.services` entry) forwards requests streaming both ways, with `x-forwarded-*` headers and the upstream's `host`, never `cookie`, `authorization` or hop-by-hop headers; `timeout` until headers (504), `idleTimeout` between chunks, 502 for connection failures and 503 for an open circuit; `stripPrefix` or `rewrite: "/api/v2/[...rest]"` change the upstream path; `auth: "required"`, `roles` and `scopes` check the user first (401, 403); the client's `x-user-id`, `x-user-roles` and `x-tenant-id` never pass, `forward` (default `["user", "tenant"]`) sends the real ones; `identity.secret` signs them and `proxyIdentity({ secret })` verifies them in the upstream; per-route `rateLimit`, `cors` (answered by the gateway), `ip` and `maxBodySize` (413) go through `ctx.feature("security").routeOptions(pattern, options)`, which any feature can call for routes without a file to tag; a target function with `allowedTargets` chooses the upstream per request; hooks `beforeProxy`, `afterProxy`, `onProxyError`; `forward(req, "orders", overrides?)` from any endpoint, hook or feature handler forwards with a route's settings, and `forward(req, { service | target, path | stripPrefix | rewrite, timeout, headers })` without a route (`proxy: {}` is enough; an inline `target` must be in `proxy.allowedTargets`, else 502), resolving the upstream `Response` for every status and rejecting with the 502/503/504 `HttpError` (`proxyRequest` is its alias); a `forwarder` replaces the calls; `websocket: true` on a route (needs `realtime: {}`) proxies WebSocket upgrades to `ws://`/`wss://` after the same checks plus the `realtime.websockets` origin and `maxConnections` checks, upgrading the client only after the upstream handshake (502 refused, 504 past `timeout`), piping frames with the `maxMessageSize` (1009) and `idleTimeout` (1001) limits, passing close codes and closing with 1014 when the upstream drops; a project endpoint on the same or a more specific path wins | |

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
