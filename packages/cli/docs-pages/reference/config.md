# Configuration

> Every key of quickservicets.config.ts.

The project configuration lives in `quickservicets.config.ts` and is written with `defineConfig({ ... })`. Nested keys are shown with dots.

Every key that holds a value can also be set by an environment variable named after its path (`server.port` is `QS_SERVER_PORT`), which wins over the config file; the older names in parentheses still work, and a `QS_*` name wins over them. Keys that hold code are not overridable.

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `database` | `DatabaseAdapter` | — | not overridable | The database adapter: `memoryAdapter()`, `sqliteAdapter(...)`, `postgresAdapter(...)` or `mongodbAdapter(...)`. |
| `server` | `object` | — | — | HTTP server settings. |
| `server.port` | `number` | 3000 | `QS_SERVER_PORT` (or `PORT`) | Port to listen on (default 3000); `PORT` overrides it. |
| `server.publicUrl` | `string` | relative URLs | `QS_SERVER_PUBLIC_URL` | Absolute base URL of the API, used in file URLs (default: relative URLs). |
| `server.workers` | `number \| "auto"` | `"auto"` in production on Linux with PostgreSQL or MongoDB, otherwise 1 | `QS_SERVER_WORKERS` (or `QS_WORKERS`) | Processes serving requests on the shared port, an integer or `"auto"` for the CPUs available, read from the container's CPU quota on Linux (default `"auto"` in production on Linux with PostgreSQL or MongoDB, otherwise 1); `QS_WORKERS` overrides it. Above 1 it needs PostgreSQL or MongoDB, and connections spread across the processes only on Linux. |
| `production` | `boolean` | false | `QS_PRODUCTION` (or `NODE_ENV`) | Production mode: hides internal error details and disables the API docs (default false); `NODE_ENV=production` turns it on. |
| `docs` | `object` | — | — | API docs settings. |
| `docs.enabled` | `boolean` | enabled unless `production` | `QS_DOCS_ENABLED` | Serve the API docs at `GET /docs` and `GET /openapi.json` (default: enabled unless `production`). |
| `docs.openapi` | `(doc: OpenApiDoc, context: ProjectOpenApiContext) => OpenApiDoc \| void \| undefined` | — | not overridable | Changes the generated OpenAPI document at build time, after every feature's `openapi` function, in place or by returning a new one. |
| `logger` | `Logger` | JSON lines on stdout | not overridable | Receives one entry per request; defaults to JSON lines on stdout. |
| `schema` | `string` | — | `QS_SCHEMA` (or `DATABASE_SCHEMA`) | Default database schema for entities without an explicit one; `DATABASE_SCHEMA` overrides it. |
| `storage` | `Record<string, StorageAdapter>` | a local storage in `uploads/` | not overridable | Named file storages; file entities use `default` unless `@storage` names another (default: a local storage in `uploads/`). |
| `files` | `object` | — | — | File upload and access settings. |
| `files.maxSize` | `number \| string` | 10 MB | `QS_FILES_MAX_SIZE` | Largest upload in bytes or as `10MB` (default 10 MB). |
| `files.accept` | `string[]` | any | `QS_FILES_ACCEPT` | Accepted MIME patterns (default any). |
| `files.access` | `"direct" \| "proxy" \| "signed"` | direct when the storage has a public URL, otherwise proxy | `QS_FILES_ACCESS` | How file URLs work (default: direct when the storage has a public URL, otherwise proxy). |
| `files.signedUrlTtl` | `number` | 900 | `QS_FILES_SIGNED_URL_TTL` | Lifetime of signed URLs in seconds (default 900). |
| `files.signingSecret` | `string` | — | `QS_FILES_SIGNING_SECRET` (or `FILES_SIGNING_SECRET`) | HMAC secret of signed proxy URLs; `FILES_SIGNING_SECRET` sets it. |
| `files.deleteOnRemove` | `boolean` | true | `QS_FILES_DELETE_ON_REMOVE` | Delete a file record's object when the record is deleted (default true). |
| `files.deleteReplaced` | `boolean` | true | `QS_FILES_DELETE_REPLACED` | Delete replaced content and files no longer referenced after a reference changes (default true). |
| `files.deleteWithOwner` | `boolean` | true | `QS_FILES_DELETE_WITH_OWNER` | Delete the files a record references when the record is deleted (default true). |
| `repositories` | `object` | — | — | Repository settings. |
| `repositories.toArrayMax` | `number` | 10000 | `QS_REPOSITORIES_TO_ARRAY_MAX` | Most records a fluent query's `toArray()` may return (default 10000). |
| `populate` | `object` | — | — | Populate settings. |
| `populate.maxDepth` | `number` | 2 | `QS_POPULATE_MAX_DEPTH` | Maximum number of segments in a populate path (default 2). |
| `migrations` | `object` | — | — | Migration settings. |
| `migrations.autoInDev` | `boolean` | true | `QS_MIGRATIONS_AUTO_IN_DEV` | Whether `quickservicets dev` creates migrations automatically for model changes (default true). |
| `env` | `Record<string, AnyOptionSchema>` | — | not overridable | Environment variables the service needs, by name, with their option schemas (like `{ DATABASE_URL: url(),
REPORT_HOUR: integer().default(6) }`); they are checked at startup and read typed from `env`. |
| `middleware` | `Middleware[]` | — | not overridable | Middlewares of the `request`, `handler` and `error` stages, run after every feature's middlewares of the same stage. |
| `lifecycle` | `object` | — | — | Time limits of the features' lifecycle callbacks. |
| `lifecycle.startTimeout` | `string` | "30s" | `QS_LIFECYCLE_START_TIMEOUT` | Longest each feature `setup` and `onStart` call may take, as a duration (default "30s"). |
| `lifecycle.stopTimeout` | `string` | "10s" | `QS_LIFECYCLE_STOP_TIMEOUT` | Longest each feature `onShutdown` and `onStop` call may take, as a duration (default "10s"). |
| `jobs` | `object` | — | — | Scheduled job settings; each job's own options override them. |
| `jobs.enabled` | `boolean` | true | `QS_JOBS_ENABLED` (or `JOBS_ENABLED`) | Run scheduled jobs in this instance (default true); `JOBS_ENABLED=false` overrides it. |
| `jobs.timeZone` | `string` | "UTC" | `QS_JOBS_TIME_ZONE` | IANA time zone cron schedules are evaluated in (default "UTC"). |
| `jobs.timeout` | `string` | "5m" | `QS_JOBS_TIMEOUT` | Longest a run may last, as a duration like `30s`, `10m` or `2h` (default "5m"). |
| `jobs.retries` | `number` | 0 | `QS_JOBS_RETRIES` | How many times a failed run is retried (default 0). |
| `jobs.retryDelay` | `string` | "30s" | `QS_JOBS_RETRY_DELAY` | Delay before the first retry, doubled for each next one, as a duration (default "30s"). |
| `jobs.retention` | `string` | "30d" | `QS_JOBS_RETENTION` | How long run records are kept, as a duration (default "30d"). |
| `jobs.shutdownGrace` | `string` | "10s" | `QS_JOBS_SHUTDOWN_GRACE` | How long shutdown waits for running jobs before recording them as interrupted, as a duration (default "10s"). |
| `jobs.limits` | `object` | — | — | Size limits of run records. |
| `jobs.limits.result` | `number \| string` | "64KB" | `QS_JOBS_LIMITS_RESULT` | Largest result stored in a run record, in bytes or as `64KB` (default "64KB"). |
| `jobs.limits.logLines` | `number` | 500 | `QS_JOBS_LIMITS_LOG_LINES` | Most log lines stored in a run record (default 500). |

## Native features

Each native feature is turned on by its key (`<key>: {}`) or by `QS_<KEY>_ENABLED=true`, and off by `<key>: false` or `QS_<KEY>_ENABLED=false`.

### `security`

Safe defaults for every service: security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists and log masking, each a switchable item.

Every option, tag, command and hook of `security` is on [its reference page](/reference/features/security/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `security.proxy.enabled` | `boolean` | `true` | `QS_SECURITY_PROXY_ENABLED` | Resolves the client address in req.ip through the proxies the project trusts. Turns it off when false. |
| `security.proxy.trust` | `cidr[]` | `[]` | `QS_SECURITY_PROXY_TRUST` | The proxies whose forwarding headers are read: addresses, CIDR blocks or loopback, private and linklocal. |
| `security.proxy.header` | `string` | `"x-forwarded-for"` | `QS_SECURITY_PROXY_HEADER` | The header trusted proxies put the client address in: x-forwarded-for, forwarded (RFC 7239) or another comma-separated list. |
| `security.proxy.resolver` | `ClientIpResolver` | — | not overridable | Replaces the trusted walk: its resolve method gets the request and its peer address and returns the client address, which is then normalized. |
| `security.headers.enabled` | `boolean` | `true` | `QS_SECURITY_HEADERS_ENABLED` | Sends the standard security headers on every response. Turns it off when false. |
| `security.headers.contentTypeOptions` | `boolean` | `true` | `QS_SECURITY_HEADERS_CONTENT_TYPE_OPTIONS` | Sends X-Content-Type-Options: nosniff. |
| `security.headers.referrerPolicy` | `string` | `"no-referrer"` | `QS_SECURITY_HEADERS_REFERRER_POLICY` | The Referrer-Policy header; an empty string leaves it out. |
| `security.headers.frameOptions` | `"DENY" \| "SAMEORIGIN"` | `"DENY"` | `QS_SECURITY_HEADERS_FRAME_OPTIONS` | The X-Frame-Options header. |
| `security.headers.csp` | `string` | `"default-src 'none'; frame-ancestors 'none'"` | `QS_SECURITY_HEADERS_CSP` | The Content-Security-Policy of API responses; an empty string leaves it out. |
| `security.headers.docsCsp` | `string` | `"default-src 'none'; script-src https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.scalar.com; font-src https://cdn.jsdelivr.net https://fonts.scalar.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"` | `QS_SECURITY_HEADERS_DOCS_CSP` | The Content-Security-Policy of GET /docs, which lets the API docs page load. |
| `security.headers.hsts.enabled` | `boolean` | `true` | `QS_SECURITY_HEADERS_HSTS_ENABLED` | Sends Strict-Transport-Security in production only. Turns it off when false. |
| `security.headers.hsts.maxAge` | `duration` | `"365d"` | `QS_SECURITY_HEADERS_HSTS_MAX_AGE` | How long browsers keep to HTTPS, sent in seconds. |
| `security.headers.hsts.includeSubDomains` | `boolean` | `true` | `QS_SECURITY_HEADERS_HSTS_INCLUDE_SUB_DOMAINS` | Adds includeSubDomains to Strict-Transport-Security. |
| `security.headers.hsts.preload` | `boolean` | `false` | `QS_SECURITY_HEADERS_HSTS_PRELOAD` | Adds preload to Strict-Transport-Security, a commitment that is hard to undo. |
| `security.files.enabled` | `boolean` | `true` | `QS_SECURITY_FILES_ENABLED` | Sends headers on served files (proxy and signed modes) that keep a browser from running them as pages of the service. Turns it off when false. |
| `security.files.attachmentTypes` | `string[]` | `["text/html","application/xhtml+xml","image/svg+xml","text/xml","application/xml","application/javascript","text/javascript","text/css"]` | `QS_SECURITY_FILES_ATTACHMENT_TYPES` | The stored types served with content-disposition: attachment, wildcards allowed; other files stay inline. |
| `security.cors.enabled` | `boolean` | `true` | `QS_SECURITY_CORS_ENABLED` | Answers cross-origin requests and preflights of the allowed origins; closed until origins are listed. Turns it off when false. |
| `security.cors.origins` | `string[]` | `[]` | `QS_SECURITY_CORS_ORIGINS` | The origins allowed to call the API from a browser: exact origins, "*", subdomain patterns like https://*.example.com, or "null"; none by default. |
| `security.cors.methods` | `string[]` | `["GET","HEAD","POST","PUT","PATCH","DELETE"]` | `QS_SECURITY_CORS_METHODS` | The methods a preflight may ask for. |
| `security.cors.headers` | `string[]` | `["content-type","authorization","idempotency-key","if-match","if-none-match","x-request-id"]` | `QS_SECURITY_CORS_HEADERS` | The request headers a preflight may ask for, compared case-insensitively. |
| `security.cors.exposeHeaders` | `string[]` | `["x-request-id","etag","location","retry-after","ratelimit-limit","ratelimit-remaining","ratelimit-reset"]` | `QS_SECURITY_CORS_EXPOSE_HEADERS` | The response headers a browser lets the calling page read. |
| `security.cors.credentials` | `boolean` | `false` | `QS_SECURITY_CORS_CREDENTIALS` | Allows cookies and authorization with cross-origin requests; not with origins "*". |
| `security.cors.maxAge` | `duration` | `"10m"` | `QS_SECURITY_CORS_MAX_AGE` | How long a browser caches a preflight answer. |
| `security.cors.onRejected` | `hook` | — | not overridable | Runs after a preflight is refused, with the request, address, route and reason. |
| `security.limits.enabled` | `boolean` | `true` | `QS_SECURITY_LIMITS_ENABLED` | Refuses oversized URLs (414), headers (431) and bodies (413) before reading them. Turns it off when false. |
| `security.limits.body` | `size` | `"1MB"` | `QS_SECURITY_LIMITS_BODY` | The largest request body, except multipart uploads, which the file settings limit. |
| `security.limits.headers` | `size` | `"16KB"` | `QS_SECURITY_LIMITS_HEADERS` | The largest total length of the request's header names and values. |
| `security.limits.headerCount` | `integer` | `100` | `QS_SECURITY_LIMITS_HEADER_COUNT` | The most headers a request may have. |
| `security.limits.url` | `size` | `"8KB"` | `QS_SECURITY_LIMITS_URL` | The longest path and query string. |
| `security.limits.onRejected` | `hook` | — | not overridable | Runs after a request is refused for its URL, headers or declared body size. |
| `security.timeouts.enabled` | `boolean` | `true` | `QS_SECURITY_TIMEOUTS_ENABLED` | Closes idle connections and refuses requests whose body arrives too slowly with 408. Turns it off when false. |
| `security.timeouts.idle` | `duration` | `"30s"` | `QS_SECURITY_TIMEOUTS_IDLE` | How long a connection may stay idle before it is closed, at most 255s (the Bun limit); 0s turns it off. |
| `security.timeouts.read` | `duration` | `"30s"` | `QS_SECURITY_TIMEOUTS_READ` | How long a request body other than an upload has to arrive, from the first read. |
| `security.timeouts.upload` | `duration` | `"10m"` | `QS_SECURITY_TIMEOUTS_UPLOAD` | How long a multipart upload has to arrive, from the first read. |
| `security.loadShedding.enabled` | `boolean` | `true` | `QS_SECURITY_LOAD_SHEDDING_ENABLED` | Refuses new requests with 503 while a worker has too many in flight, so it stays responsive under overload. Turns it off when false. |
| `security.loadShedding.maxInFlight` | `integer` | `1000` | `QS_SECURITY_LOAD_SHEDDING_MAX_IN_FLIGHT` | The most requests one worker serves at once; more are refused with 503. |
| `security.loadShedding.retryAfter` | `duration` | `"1s"` | `QS_SECURITY_LOAD_SHEDDING_RETRY_AFTER` | The Retry-After of a refusal, sent in whole seconds. |
| `security.loadShedding.onShed` | `hook` | — | not overridable | Runs after a request is refused because the worker is busy. |
| `security.rateLimit.enabled` | `boolean` | `true` | `QS_SECURITY_RATE_LIMIT_ENABLED` | Limits how many requests each client address makes in a time window, answering 429 with RateLimit headers. Turns it off when false. |
| `security.rateLimit.limit` | `rate` | `"1000/min"` | `QS_SECURITY_RATE_LIMIT_LIMIT` | The requests each bucket may make per window, like 1000/min or 10/s; a function of the request context (req, user and tenant) computes it per request. |
| `security.rateLimit.by` | `("route" \| "ip" \| "user" \| "tenant")[]` | `["ip"]` | `QS_SECURITY_RATE_LIMIT_BY` | What a bucket is per: the client address (ip), the route, the user or the tenant, combined. |
| `security.rateLimit.store` | `"memory" \| "database" \| RateLimitStore` | `"memory"` | `QS_SECURITY_RATE_LIMIT_STORE` | Where the counters live: "memory" keeps them per worker; "database" shares them across workers and replicas through the project's database; a RateLimitStore replaces both. |
| `security.rateLimit.syncInterval` | `duration` | `"1s"` | `QS_SECURITY_RATE_LIMIT_SYNC_INTERVAL` | How often the "database" store sends its pending counts and reads the shared totals back. |
| `security.rateLimit.memory.maxKeys` | `integer` | `100000` | `QS_SECURITY_RATE_LIMIT_MEMORY_MAX_KEYS` | The most buckets the memory store keeps; the least recently used one is evicted. |
| `security.rateLimit.onLimited` | `hook` | — | not overridable | Runs after a request is refused with 429, with the bucket's key and limit. |
| `security.ip.enabled` | `boolean` | `true` | `QS_SECURITY_IP_ENABLED` | Accepts or refuses requests by client address (req.ip), for the whole service or with tags for single routes. Turns it off when false. |
| `security.ip.allow` | `cidr[]` | `[]` | `QS_SECURITY_IP_ALLOW` | When not empty, only these addresses are served: addresses, CIDR blocks or loopback, private and linklocal. |
| `security.ip.deny` | `cidr[]` | `[]` | `QS_SECURITY_IP_DENY` | Addresses refused with 403; a deny match wins over an allow match. |
| `security.ip.onBlocked` | `hook` | — | not overridable | Runs after a request is refused for its address. |
| `security.csrf.enabled` | `boolean` | `true` | `QS_SECURITY_CSRF_ENABLED` | Refuses cross-site writes (POST, PUT, PATCH, DELETE) that ride on a session cookie with 403; requests authenticated by tokens, or not at all, skip it. Turns it off when false. |
| `security.csrf.mode` | `"origin" \| "token"` | `"origin"` | `QS_SECURITY_CSRF_MODE` | How cookie-authenticated writes prove they come from the service's pages: their Origin (or Referer) and Sec-Fetch-Site headers, or a token header equal to the CSRF cookie. |
| `security.csrf.origins` | `string[]` | `[]` | `QS_SECURITY_CSRF_ORIGINS` | Origins allowed to send cookie-authenticated writes besides the service's own and security.cors.origins. |
| `security.csrf.cookie` | `string` | `"qs_csrf"` | `QS_SECURITY_CSRF_COOKIE` | The cookie that carries the token in token mode. |
| `security.csrf.header` | `string` | `"x-csrf-token"` | `QS_SECURITY_CSRF_HEADER` | The request header that must repeat the cookie's token in token mode. |
| `security.masking.enabled` | `boolean` | `true` | `QS_SECURITY_MASKING_ENABLED` | Keeps secret values and fields tagged @sensitive out of log entries, job run records and development error responses. Turns it off when false. |
| `security.masking.keys` | `string[]` | `["password","passwd","secret","token","apikey","authorization","cookie","setcookie","privatekey","clientsecret","signature","creditcard","cardnumber","cvv"]` | `QS_SECURITY_MASKING_KEYS` | A logged property whose name contains one of these (ignoring case, - and _) shows [secret] instead of its value. |
| `security.enabled` | `boolean` | `true` | `QS_SECURITY_ENABLED` | Turns the feature off when false. |

#### `@limits`

Raises or lowers the body limit of one route, or of each route of an entity, like an import endpoint that takes large JSON bodies.

**Applies to:** endpoints, entities

**Options:** `limits.body`

**Syntax:** `@limits [body=…]` or `@limits off`

```ts
/** @limits body=20MB */
export default handler;
```

#### `@sensitive`

Marks a field whose value never appears in log entries or job run records, shown there as [sensitive]; API responses keep it (use @hidden to leave it out).

**Applies to:** fields

**Options:** none (a flag: `@sensitive` or `@sensitive off`)

**Syntax:** `@sensitive` or `@sensitive off`

```ts
export type Customer = {
  /** @sensitive */
  taxId: string;
};
```

#### `@ipAllow`

Serves one route, or each route of an entity, only to the listed addresses, on top of the global lists.

**Applies to:** endpoints, entities

**Options:** `ip.allow`

**Syntax:** `@ipAllow <allow>` or `@ipAllow off`

```ts
/** @ipAllow private,loopback */
export default handler;
```

#### `@ipDeny`

Refuses the listed addresses on one route, or on each route of an entity, on top of the global lists.

**Applies to:** endpoints, entities

**Options:** `ip.deny`

**Syntax:** `@ipDeny <deny>` or `@ipDeny off`

```ts
/** @ipDeny 203.0.113.0/24 */
export default handler;
```

#### `@rateLimit`

Gives one route, or each route of an entity, its own rate limit on top of the global one, always keyed by route; `@rateLimit off` exempts the route from every rate limit.

**Applies to:** endpoints, entities

**Options:** `rateLimit.limit`, `rateLimit.by`

**Syntax:** `@rateLimit <limit> [by=…]` or `@rateLimit off`

```ts
/** @rateLimit 10/min by=user */
export default handler;
```

#### `@cors`

Replaces the CORS options for the preflights and requests of one route or of an entity's routes; `@cors off` turns CORS handling off there.

**Applies to:** endpoints, entities

**Options:** `cors.origins`, `cors.credentials`, `cors.methods`, `cors.headers`

**Syntax:** `@cors [origins=…] [credentials=…] [methods=…] [headers=…]` or `@cors off`

```ts
/** @cors origins=https://partner.example credentials=true */
export default handler;
```

#### `@csrf`

`@csrf off` lets one route, or each route of an entity, accept cookie-authenticated writes from other sites, like a beacon endpoint.

**Applies to:** endpoints, entities

**Options:** none (a flag: `@csrf` or `@csrf off`)

**Syntax:** `@csrf` or `@csrf off`

```ts
/** @csrf off */
export default handler;
```

#### `@securityHeaders`

Changes the security headers of one route or of an entity's routes; `@securityHeaders off` sends none of them there.

**Applies to:** endpoints, entities

**Options:** `headers.csp`, `headers.frameOptions`, `headers.referrerPolicy`

**Syntax:** `@securityHeaders [csp=…] [frameOptions=…] [referrerPolicy=…]` or `@securityHeaders off`

```ts
/** @securityHeaders csp="default-src 'self'" */
export default handler;
```

### `events`

Write events for every entity, delivered to listeners inside the write's transaction or after its commit.

Every option, tag, command and hook of `events` is on [its reference page](/reference/features/events/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `events.outbox.enabled` | `boolean` | `true` | `QS_EVENTS_OUTBOX_ENABLED` | Stores the chosen events in the write's transaction, so any worker or replica reads every committed event. Turns it off when false. |
| `events.outbox.events` | `string[]` | `["*"]` | `QS_EVENTS_OUTBOX_EVENTS` | The event patterns stored in the outbox. |
| `events.outbox.retention` | `duration` | `"7d"` | `QS_EVENTS_OUTBOX_RETENTION` | How long outbox rows are kept; rows with undelivered deliveries stay. |
| `events.outbox.dispatch` | `boolean` | `true` | `QS_EVENTS_OUTBOX_DISPATCH` | Runs the delivery dispatcher in this worker. |
| `events.outbox.delivery.pollInterval` | `duration` | `"1s"` | `QS_EVENTS_OUTBOX_DELIVERY_POLL_INTERVAL` | How often the dispatcher looks for due deliveries. |
| `events.outbox.delivery.batch` | `integer` | `100` | `QS_EVENTS_OUTBOX_DELIVERY_BATCH` | Deliveries claimed per poll. |
| `events.outbox.delivery.timeout` | `duration` | `"30s"` | `QS_EVENTS_OUTBOX_DELIVERY_TIMEOUT` | How long a delivery may run before it is aborted and retried; the lease of a claimed row. |
| `events.outbox.delivery.retries` | `integer` | `10` | `QS_EVENTS_OUTBOX_DELIVERY_RETRIES` | Failed attempts before a delivery becomes failed. |
| `events.outbox.delivery.retryDelay` | `duration` | `"10s"` | `QS_EVENTS_OUTBOX_DELIVERY_RETRY_DELAY` | The first retry delay, doubled each attempt. |
| `events.outbox.delivery.maxRetryDelay` | `duration` | `"1h"` | `QS_EVENTS_OUTBOX_DELIVERY_MAX_RETRY_DELAY` | The longest retry delay. |
| `events.beforeEmit` | `hook` | — | not overridable | Runs before an event reaches any listener or the outbox; returns a changed event or null to drop it, and a throw fails the write. |
| `events.afterEmit` | `hook` | — | not overridable | Runs after an event was stored and handed to after-commit dispatch. |
| `events.bus` | `EventBus` | — | not overridable | Replaces the in-process after-commit dispatch; in-transaction listeners and the outbox stay. |
| `events.enabled` | `boolean` | `true` | `QS_EVENTS_ENABLED` | Turns the feature off when false. |

#### `@events`

`@events off` stops every event of the entity, so its writes keep their plain statements; `@events outbox=false` keeps its events out of the outbox.

**Applies to:** entities

**Options:** `outbox`

**Syntax:** `@events [outbox=…]` or `@events off`

```ts
/** @events off */
export type Session = { token: string };
```

### `queues`

Background queues stored in the project's database, with consumers declared as files in queues/.

Every option, tag, command and hook of `queues` is on [its reference page](/reference/features/queues/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `queues.consume` | `boolean` | `true` | `QS_QUEUES_CONSUME` | Runs the consumers in this process; false keeps add working in processes that only enqueue. |
| `queues.concurrency` | `integer` | `1` | `QS_QUEUES_CONCURRENCY` | How many messages of each queue run at once in one process. |
| `queues.pollInterval` | `duration` | `"1s"` | `QS_QUEUES_POLL_INTERVAL` | How long an idle consumer waits before it looks for messages again. |
| `queues.timeout` | `duration` | `"5m"` | `QS_QUEUES_TIMEOUT` | The longest a message may run; the lease of a claimed message. |
| `queues.retries` | `integer` | `3` | `QS_QUEUES_RETRIES` | How many times a failed message is retried before it is dead. |
| `queues.retryDelay` | `duration` | `"10s"` | `QS_QUEUES_RETRY_DELAY` | The delay before the first retry, doubled for each next one. |
| `queues.maxRetryDelay` | `duration` | `"1h"` | `QS_QUEUES_MAX_RETRY_DELAY` | The longest delay between two attempts. |
| `queues.retention.completed` | `duration` | `"7d"` | `QS_QUEUES_RETENTION_COMPLETED` | How long completed messages are kept after they finish. |
| `queues.retention.dead` | `duration` | `"30d"` | `QS_QUEUES_RETENTION_DEAD` | How long dead messages are kept after they finish. |
| `queues.overrides.<name>.concurrency` | `record of integer` | — | `QS_QUEUES_OVERRIDES_<NAME>_CONCURRENCY` | How many messages of the queue run at once in one process. |
| `queues.overrides.<name>.timeout` | `record of duration` | — | `QS_QUEUES_OVERRIDES_<NAME>_TIMEOUT` | The longest a message of the queue may run. |
| `queues.overrides.<name>.retries` | `record of integer` | — | `QS_QUEUES_OVERRIDES_<NAME>_RETRIES` | How many times a failed message of the queue is retried. |
| `queues.overrides.<name>.retryDelay` | `record of duration` | — | `QS_QUEUES_OVERRIDES_<NAME>_RETRY_DELAY` | The first retry delay of the queue. |
| `queues.overrides.<name>.dedupeWindow` | `record of duration` | — | `QS_QUEUES_OVERRIDES_<NAME>_DEDUPE_WINDOW` | How long a completed message of the queue keeps deduplicating its key. |
| `queues.defaultPriority` | `integer` | `0` | `QS_QUEUES_DEFAULT_PRIORITY` | The priority of req.queue.add calls that give none; a function of the request, its user and tenant sets it per request. |
| `queues.defaultDelay` | `duration` | — | `QS_QUEUES_DEFAULT_DELAY` | The delay of req.queue.add calls that give neither delay nor runAt; a function of the request sets it per request. |
| `queues.beforeEnqueue` | `hook` | — | not overridable | Runs before a message is added with the queue, payload and options; returns them changed, and a throw cancels the add. |
| `queues.afterEnqueue` | `hook` | — | not overridable | Runs after a message was added, with its queue, id and whether it was deduplicated. |
| `queues.beforeProcess` | `hook` | — | not overridable | Runs before a consumer with the message and payload; returns a changed payload, and a throw fails the attempt. |
| `queues.afterProcess` | `hook` | — | not overridable | Runs after each run with the message, its status, result or error and duration. |
| `queues.onDead` | `hook` | — | not overridable | Runs when a message used its last attempt, with the message and the error. |
| `queues.broker` | `QueueBroker` | — | not overridable | Replaces the database broker, so messages live in another broker such as RabbitMQ, Kafka, Redis or SQS. |
| `queues.publish.queue` | `string` | `"events"` | `QS_QUEUES_PUBLISH_QUEUE` | The queue an entity tagged @publish sends its write events to. |
| `queues.publish.events` | `("created" \| "updated" \| "deleted")[]` | `["created","updated","deleted"]` | `QS_QUEUES_PUBLISH_EVENTS` | The write operations a tagged entity publishes: created, updated and deleted. |
| `queues.publish.fields` | `string[]` | — | `QS_QUEUES_PUBLISH_FIELDS` | The only fields, with id, kept in a published event's before and after; all but hidden and sensitive fields without it. |
| `queues.enabled` | `boolean` | `true` | `QS_QUEUES_ENABLED` | Turns the feature off when false. |

#### `@publish`

`@publish` sends the entity's write events to a queue (`publish.queue`, default `events`) in the write's transaction; `events` limits the operations, `fields` the fields of `before` and `after`.

**Applies to:** entities

**Options:** `publish.events`, `publish.queue`, `publish.fields`

**Syntax:** `@publish <events> [queue=…] [fields=…]` or `@publish off`

```ts
/** @publish created,updated queue=crm-sync */
export type User = { email: string };
```

### `health`

Liveness and readiness routes for orchestrators and load balancers, checking the database, the queue and the checks features add.

Every option, tag, command and hook of `health` is on [its reference page](/reference/features/health/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `health.live` | `string` | `"/health/live"` | `QS_HEALTH_LIVE` | The path of the liveness route, which answers 200 while the process serves requests. |
| `health.ready` | `string` | `"/health/ready"` | `QS_HEALTH_READY` | The path of the readiness route, which runs the checks. |
| `health.timeout` | `duration` | `"2s"` | `QS_HEALTH_TIMEOUT` | The time limit of each check. |
| `health.cache` | `duration` | `"1s"` | `QS_HEALTH_CACHE` | How long a readiness result is reused by the probes of one worker; 0s runs the checks for every probe. |
| `health.details` | `boolean` | — | `QS_HEALTH_DETAILS` | Shows each check's error and extra fields in the ready response; on outside production and off in production by default. A function of the request decides per request. |
| `health.log` | `boolean` | `false` | `QS_HEALTH_LOG` | Writes a request log entry for every probe; without it only 5xx responses of the health routes are logged. |
| `health.drainDelay` | `duration` | — | `QS_HEALTH_DRAIN_DELAY` | How long ready answers draining after a shutdown signal before the listener closes; 5s in production and 0s otherwise by default. |
| `health.checks.<name>` | `record of hook \| object` | — | not overridable | A check: a function resolving (healthy, with extra fields) or throwing, or an object with check and critical false for a non-critical one. |
| `health.beforeCheck` | `hook` | — | not overridable | Runs before each check with its name; returning false skips the check for that probe, reported as skipped. |
| `health.afterCheck` | `hook` | — | not overridable | Runs after each check with its name, status, duration and error. |
| `health.onStatusChange` | `hook` | — | not overridable | Runs when the overall readiness of this worker changes, with the old and new status and the checks; with events enabled the change is also the event health.status.changed. |
| `health.prober` | `HealthProber` | — | not overridable | Replaces how the checks are run and combined: its run method gets the registered checks and returns the ready response. |
| `health.enabled` | `boolean` | `true` | `QS_HEALTH_ENABLED` | Turns the feature off when false. |

### `idempotency`

Idempotency keys: a request repeated with the same Idempotency-Key gets the first response again without running twice.

Every option, tag, command and hook of `idempotency` is on [its reference page](/reference/features/idempotency/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `idempotency.header` | `string` | `"Idempotency-Key"` | `QS_IDEMPOTENCY_HEADER` | The request header that carries the key. |
| `idempotency.methods` | `("POST" \| "PUT" \| "PATCH" \| "DELETE")[]` | `["POST"]` | `QS_IDEMPOTENCY_METHODS` | The methods whose routes honor keys; @idempotent turns a route on for any method. |
| `idempotency.required` | `boolean` | `false` | `QS_IDEMPOTENCY_REQUIRED` | Rejects requests without the header with 400 on the routes that honor keys; a function of the request decides per request. |
| `idempotency.ttl` | `duration` | `"24h"` | `QS_IDEMPOTENCY_TTL` | How long a stored response is replayed for its key; a function of the request decides per request. |
| `idempotency.maxResponseSize` | `size` | `"1MB"` | `QS_IDEMPOTENCY_MAX_RESPONSE_SIZE` | The largest response body stored for replays; larger ones release the key. |
| `idempotency.scope` | `string` | — | `QS_IDEMPOTENCY_SCOPE` | Replaces the user part of a key's scope: a function of the request, its user and tenant returning a text, like the tenant id with the user id. |
| `idempotency.beforeReplay` | `hook` | — | not overridable | Runs before a stored response is replayed with the request and the record; returning false deletes the record and runs the request again. |
| `idempotency.afterStore` | `hook` | — | not overridable | Runs after a response was stored for a key, with the request and the record. |
| `idempotency.onConflict` | `hook` | — | not overridable | Runs when a key is refused, with the request and the kind: reused for another request, inUse for one in progress. |
| `idempotency.store` | `IdempotencyStore` | — | not overridable | Replaces where keys are kept; without the IdempotencyKey entity in the build. |
| `idempotency.enabled` | `boolean` | `true` | `QS_IDEMPOTENCY_ENABLED` | Turns the feature off when false. |

#### `@idempotent`

`@idempotent` honors keys on an endpoint whatever its method, or on an entity's create route; `required` and `ttl` override the options there, and `@idempotent off` ignores keys.

**Applies to:** entities, endpoints

**Options:** `required`, `ttl`

**Syntax:** `@idempotent [required=…] [ttl=…]` or `@idempotent off`

```ts
/** @idempotent required=true ttl=7d */
export type Order = { total: number };
```

### `etag`

Entity tags on record reads and writes, with 304 answers to conditional reads and 412 answers to stale conditional writes.

Every option, tag, command and hook of `etag` is on [its reference page](/reference/features/etag/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `etag.required` | `boolean` | `false` | `QS_ETAG_REQUIRED` | Rejects PATCH, PUT and DELETE requests of the generated routes without If-Match with 428; a function of the request decides per request. |
| `etag.onPreconditionFailed` | `hook` | — | not overridable | Runs when a conditional write is refused, with the request, entity, id, expected and current tags; a Response it returns replaces the 412. |
| `etag.onNotModified` | `hook` | — | not overridable | Runs for each 304 answer, with the request, the entity and the id. |
| `etag.tagger` | `EntityTagger` | — | not overridable | Replaces etagOf for the native's routes: its tag method gets the stored record and the entity and returns a strong tag. |
| `etag.enabled` | `boolean` | `true` | `QS_ETAG_ENABLED` | Turns the feature off when false. |

#### `@etag`

`@etag required=true` requires If-Match on the entity's PATCH, PUT and DELETE routes, `@etag required=false` exempts it, and `@etag off` removes tags and conditions from its routes.

**Applies to:** entities

**Options:** `required`

**Syntax:** `@etag [required=…]` or `@etag off`

```ts
/** @etag required=true */
export type Invoice = { total: number };
```

### `history`

Every version of the records of chosen entities, kept in a history table written in the same transaction as the change.

Every option, tag, command and hook of `history` is on [its reference page](/reference/features/history/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `history.entities` | `"tagged" \| "all"` | `"tagged"` | `QS_HISTORY_ENTITIES` | Which entities keep history: tagged keeps it for entities tagged @history, all for every regular entity without @history off. |
| `history.retention` | `duration` | — | `QS_HISTORY_RETENTION` | How long versions are kept, like 365d; the current version of a live record is always kept, and without it versions are kept forever. A function of the entity and tenant decides per tenant when pruning. |
| `history.beforeVersion` | `hook` | — | not overridable | Runs inside the write's transaction before each version is written, with the entity, the version and the event; it may return a changed step or null to skip the version, and a throw fails the write. |
| `history.afterVersion` | `hook` | — | not overridable | Runs after the write committed, with the entity, the stored version and the event; failures are logged. |
| `history.store` | `HistoryStore` | — | not overridable | Replaces the history tables: it writes, lists, reads and prunes versions, and the build adds no history entities. |
| `history.enabled` | `boolean` | `true` | `QS_HISTORY_ENABLED` | Turns the feature off when false. |

#### `@history`

`@history` on an entity keeps its versions, `@history retention=7d` sets how long, and `@history off` excludes it; on a field, `@history off` leaves it out of versions and `@history on` keeps a `@hidden` or `@sensitive` field in them.

**Applies to:** entities, fields

**Options:** `retention`

**Syntax:** `@history [retention=…]` or `@history off`

```ts
/** @history retention=90d */
export type Contract = {
  title: string;
  /** @history off */
  draftNotes: string;
};
```

### `realtime`

Server-Sent Events endpoints from sse.ts files and WebSocket endpoints from ws.ts files, with limits per worker and per socket.

Every option, tag, command and hook of `realtime` is on [its reference page](/reference/features/realtime/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `realtime.sse.enabled` | `boolean` | `true` | `QS_REALTIME_SSE_ENABLED` | Serves the sse.ts endpoints as Server-Sent Events streams. Turns it off when false. |
| `realtime.sse.heartbeat` | `duration` | `"15s"` | `QS_REALTIME_SSE_HEARTBEAT` | How often an open stream writes a ping comment, so proxies and clients keep it open. |
| `realtime.sse.maxStreams` | `integer` | `1000` | `QS_REALTIME_SSE_MAX_STREAMS` | The most streams one worker keeps open; more are refused with 503 and Retry-After: 5. |
| `realtime.sse.changes` | `"tagged" \| "all"` | `"tagged"` | `QS_REALTIME_SSE_CHANGES` | Which entities get a change stream route: tagged for entities tagged @changes, all for every entity with list routes without @changes off. |
| `realtime.sse.pollInterval` | `duration` | `"1s"` | `QS_REALTIME_SSE_POLL_INTERVAL` | How often a worker with open change streams reads the outbox log, when events.outbox is on. |
| `realtime.sse.buffer` | `integer` | `1000` | `QS_REALTIME_SSE_BUFFER` | How many change events each worker keeps for reconnecting clients, when events.outbox is off. |
| `realtime.sse.events` | `("created" \| "updated" \| "deleted")[]` | `["created","updated","deleted"]` | `QS_REALTIME_SSE_EVENTS` | The write events change streams offer; @changes events=created limits one entity, and a client asking for others gets 400. |
| `realtime.sse.beforeDeliver` | `hook` | — | not overridable | Runs for each change and open change stream with the request, its user and tenant, the event and the entity; returning false skips the change for that stream, and a throw skips it and is logged. |
| `realtime.sse.beforeSend` | `hook` | — | not overridable | Runs before each change message is written with the request, the event and the data; it returns changed data, or null to skip the message. |
| `realtime.sse.changeSource` | `ChangeSource` | — | not overridable | Replaces the outbox and ring buffer sources: subscribe delivers live write events of some entities, and replay the ones after an event id or expired. |
| `realtime.websockets.enabled` | `boolean` | `true` | `QS_REALTIME_WEBSOCKETS_ENABLED` | Serves the ws.ts endpoints as WebSockets, upgraded after the handler middlewares and the endpoint's pre-hooks. Turns it off when false. |
| `realtime.websockets.origins` | `string[]` | — | `QS_REALTIME_WEBSOCKETS_ORIGINS` | Browser origins allowed to open sockets besides the service's own; security.cors.origins when unset. Requests without Origin (non-browser clients) always pass. |
| `realtime.websockets.maxConnections` | `integer` | `10000` | `QS_REALTIME_WEBSOCKETS_MAX_CONNECTIONS` | The most sockets one worker keeps open; more upgrades answer 503 with Retry-After: 5. |
| `realtime.websockets.maxMessageSize` | `size` | `"1MB"` | `QS_REALTIME_WEBSOCKETS_MAX_MESSAGE_SIZE` | The largest frame a socket accepts; a larger one closes the socket with 1009, and one over twice the limit ends the connection. |
| `realtime.websockets.idleTimeout` | `duration` | `"120s"` | `QS_REALTIME_WEBSOCKETS_IDLE_TIMEOUT` | How long a socket may stay silent before it is closed, at most 960s; Bun pings to keep live connections open. |
| `realtime.websockets.messages` | `rate` | `"100/10s"` | `QS_REALTIME_WEBSOCKETS_MESSAGES` | The frames each socket may send per window; exceeding it closes the socket with 1008 Too many messages. |
| `realtime.websockets.maxRooms` | `integer` | `100` | `QS_REALTIME_WEBSOCKETS_MAX_ROOMS` | The most rooms one socket joins; one more subscribe throws Socket joined too many rooms. |
| `realtime.websockets.transport` | `"local" \| SocketTransport` | `"local"` | `QS_REALTIME_WEBSOCKETS_TRANSPORT` | How room messages and disconnects reach the sockets of other workers and replicas: "local" keeps them in this process; a SocketTransport delivers them everywhere. |
| `realtime.enabled` | `boolean` | `true` | `QS_REALTIME_ENABLED` | Turns the feature off when false. |

#### `@changes`

`@changes` gives the entity a change stream at `GET /<collection>/changes`, `@changes events=created,deleted` limits the events it offers, and `@changes off` removes it when `sse.changes` is `all`.

**Applies to:** entities

**Options:** `sse.events`

**Syntax:** `@changes [events=…]` or `@changes off`

```ts
/** @changes events=created,deleted */
export type Task = { title: string; status: string };
```

### `errors`

One interface that receives every unexpected error with its request, user and tenant, so a reporting service plugs in with one line.

Every option, tag, command and hook of `errors` is on [its reference page](/reference/features/errors/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `errors.reporter` | `ErrorReporter \| ErrorReporter[]` | — | `QS_ERRORS_REPORTER` | Receives every report: one reporter or a list, each an object with report(report) and an optional flush(timeoutMs); without it, consoleReporter() writes error.report log entries. |
| `errors.release` | `string` | — | `QS_ERRORS_RELEASE` | The release of the service added to every report, like a version or a commit. |
| `errors.tags.<name>` | `record of string` | — | `QS_ERRORS_TAGS_<NAME>` | The value of the tag. |
| `errors.sampleRate` | `number` | `1` | `QS_ERRORS_SAMPLE_RATE` | The probability each report is sent, decided once per report; startup reports are always sent. |
| `errors.ignore` | `string[]` | `[]` | `QS_ERRORS_IGNORE` | Error names, like AbortError, and response statuses, like 503, whose reports are dropped before sampling. |
| `errors.beforeReport` | `hook` | — | not overridable | Runs on each report after masking and before the reporters; it returns a changed report, or null to drop it, and a throw is logged and drops nothing. |
| `errors.jobs` | `"final" \| "every"` | `"final"` | `QS_ERRORS_JOBS` | Which failed job runs and queue attempts are reported: final reports a run only when no retry follows, every reports each failed attempt. |
| `errors.enabled` | `boolean` | `true` | `QS_ERRORS_ENABLED` | Turns the feature off when false. |

#### `@report`

`@report off` stops the request reports of the endpoint or of the entity's routes, and `@report sampleRate=0.1` sets their sampling rate.

**Applies to:** entities, endpoints

**Options:** `sampleRate`

**Syntax:** `@report [sampleRate=…]` or `@report off`

```ts
/** @report sampleRate=0.1 */
export default () => ({ ok: true });
```

### `flags`

Feature flags turned on per user, per tenant or for a percentage of users, read synchronously in any endpoint or hook.

Every option, tag, command and hook of `flags` is on [its reference page](/reference/features/flags/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `flags.source` | `"config" \| "database"` | `"config"` | `QS_FLAGS_SOURCE` | Where the flags live: the rules of the config, or the FeatureFlag table with the config rules as defaults. |
| `flags.rules.<name>.enabled` | `record of boolean` | `true` | `QS_FLAGS_RULES_<NAME>_ENABLED` | One flag: true or false for everyone, who it is on for, or a function of the request, its user and tenant returning a boolean synchronously. Turns it off when false. |
| `flags.rules.<name>.users` | `record of string[]` | — | `QS_FLAGS_RULES_<NAME>_USERS` | The user ids the flag is on for. |
| `flags.rules.<name>.tenants` | `record of string[]` | — | `QS_FLAGS_RULES_<NAME>_TENANTS` | The tenant ids the flag is on for. |
| `flags.rules.<name>.percentage` | `record of integer` | — | `QS_FLAGS_RULES_<NAME>_PERCENTAGE` | The share of users (or tenants without a user) the flag is on for, stable across processes. |
| `flags.rules.<name>.description` | `record of string` | — | `QS_FLAGS_RULES_<NAME>_DESCRIPTION` | What the flag turns on, for people reading the config. |
| `flags.refresh` | `duration` | `"30s"` | `QS_FLAGS_REFRESH` | How often each worker reloads the flags of the database source. |
| `flags.gate` | `string` | — | `QS_FLAGS_GATE` | A flag every route needs: while it is off for a caller, every route answers 404; set per endpoint or entity with @flag. |
| `flags.onEvaluate` | `hook` | — | not overridable | Runs after each new evaluation with the name, the value, the reason, the user, the tenant and the request; it observes and cannot change the value. |
| `flags.provider` | `FlagProvider` | — | not overridable | Replaces the evaluation of both sources: isOn(name, ctx) answers synchronously, all(ctx) lists every flag, and optional start() and stop() run with the server. |
| `flags.enabled` | `boolean` | `true` | `QS_FLAGS_ENABLED` | Turns the feature off when false. |

#### `@flag`

`@flag checkout-v2` hides an endpoint, or every route of an entity, behind a flag: while it is off for the caller they answer 404; `@flag off` removes the global gate.

**Applies to:** entities, endpoints

**Options:** `gate`

**Syntax:** `@flag <gate>` or `@flag off`

```ts
/** @flag checkout-v2 */
export default () => ({ ok: true });
```

### `http`

A fluent, typed client for calling other HTTP services, with timeouts, size limits and clear errors by default.

Every option, tag, command and hook of `http` is on [its reference page](/reference/features/http/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `http.timeout` | `duration` | `"10s"` | `QS_HTTP_TIMEOUT` | The longest an outgoing call may take, reading the response body included; a call sets its own with .timeout(). |
| `http.maxResponseSize` | `size` | `"10MB"` | `QS_HTTP_MAX_RESPONSE_SIZE` | The largest response body a call reads; a larger one fails the call with RESPONSE_TOO_LARGE. |
| `http.userAgent` | `string` | `"quickservicets/0.2.0"` | `QS_HTTP_USER_AGENT` | The user-agent header of every outgoing call, unless the call sets one. |
| `http.ssrf` | `boolean` | `true` | `QS_HTTP_SSRF` | Blocks calls to internal networks, the machine itself and cloud metadata endpoints, checking every resolved address and every redirect. |
| `http.allow` | `string[]` | `[]` | `QS_HTTP_ALLOW` | Addresses, CIDR blocks (or loopback, private, linklocal) and host names like billing.internal or *.internal that SSRF protection lets through. |
| `http.maxRedirects` | `integer` | `5` | `QS_HTTP_MAX_REDIRECTS` | How many redirects a call follows before it fails with TOO_MANY_REDIRECTS. |
| `http.log` | `"all" \| "errors" \| "off"` | `"all"` | `QS_HTTP_LOG` | Which calls write an http.call log entry: all of them, only failed calls and statuses of 400 and above, or none. |
| `http.beforeRequest` | `hook` | — | not overridable | Runs before every attempt next to the transport, with the request; it may return a changed request, and a throw cancels the call with that error. |
| `http.afterResponse` | `hook` | — | not overridable | Runs after every attempt that got a response, with the request, the response and the duration. |
| `http.onError` | `hook` | — | not overridable | Runs after every attempt that failed, with the request and the HttpClientError. |
| `http.transport` | `HttpTransport` | — | not overridable | Replaces how a request is sent: its fetch(request, context) gets a standard Request with the abort signal and the address SSRF protection validated, and resolves a Response. |
| `http.services.<name>.url` | `record of url` | — | `QS_HTTP_SERVICES_<NAME>_URL` | The service's base URL; call paths are joined to its path, like https://billing.internal/v1. |
| `http.services.<name>.headers.<name>` | `record of record of string` | — | `QS_HTTP_SERVICES_<NAME>_HEADERS_<NAME>` | The value of the header. |
| `http.services.<name>.auth.bearer` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BEARER` | Sends the token as authorization: Bearer. |
| `http.services.<name>.auth.basic.username` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BASIC_USERNAME` | The user name. |
| `http.services.<name>.auth.basic.password` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BASIC_PASSWORD` | The password. |
| `http.services.<name>.auth.apiKey.header` | `record of string` | `"x-api-key"` | `QS_HTTP_SERVICES_<NAME>_AUTH_API_KEY_HEADER` | The header that carries the key. |
| `http.services.<name>.auth.apiKey.value` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_API_KEY_VALUE` | The key. |
| `http.services.<name>.timeout` | `record of duration` | — | `QS_HTTP_SERVICES_<NAME>_TIMEOUT` | The timeout of calls to the service, instead of http.timeout. |
| `http.services.<name>.propagate` | `record of ("user" \| "tenant" \| "authorization")[]` | `[]` | `QS_HTTP_SERVICES_<NAME>_PROPAGATE` | What calls through req.http carry from the request: user sends x-user-id, tenant sends x-tenant-id, authorization forwards the incoming authorization header. |
| `http.services.<name>.log` | `record of "all" \| "errors" \| "off"` | — | `QS_HTTP_SERVICES_<NAME>_LOG` | Which calls to the service write http.call entries, instead of http.log. |
| `http.services.<name>.retry.enabled` | `record of boolean` | `true` | `QS_HTTP_SERVICES_<NAME>_RETRY_ENABLED` | Retries calls to the service that are safe to retry. Turns it off when false. |
| `http.services.<name>.retry.attempts` | `record of integer` | `3` | `QS_HTTP_SERVICES_<NAME>_RETRY_ATTEMPTS` | Attempts in total, the first included. |
| `http.services.<name>.retry.backoff` | `record of duration` | `"200ms"` | `QS_HTTP_SERVICES_<NAME>_RETRY_BACKOFF` | The first backoff, doubled for each next attempt, with full jitter. |
| `http.services.<name>.retry.maxBackoff` | `record of duration` | `"5s"` | `QS_HTTP_SERVICES_<NAME>_RETRY_MAX_BACKOFF` | The longest backoff. |
| `http.services.<name>.retry.methods` | `record of ("GET" \| "HEAD" \| "OPTIONS" \| "PUT" \| "DELETE" \| "POST" \| "PATCH")[]` | `["GET","HEAD","OPTIONS","PUT","DELETE"]` | `QS_HTTP_SERVICES_<NAME>_RETRY_METHODS` | The methods retried; POST and PATCH are also retried when the request has an Idempotency-Key header. |
| `http.services.<name>.retry.on` | `record of (integer \| "NETWORK" \| "TIMEOUT")[]` | `[408,429,502,503,504,"NETWORK","TIMEOUT"]` | `QS_HTTP_SERVICES_<NAME>_RETRY_ON` | The statuses and error codes retried. |
| `http.services.<name>.retry.maxRetryAfter` | `record of duration` | `"30s"` | `QS_HTTP_SERVICES_<NAME>_RETRY_MAX_RETRY_AFTER` | The longest Retry-After waited; a longer one is not retried. |
| `http.services.<name>.circuitBreaker.enabled` | `record of boolean` | `true` | `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_ENABLED` | Stops calling the service for a while after repeated failures. Turns it off when false. |
| `http.services.<name>.circuitBreaker.failures` | `record of integer` | `5` | `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_FAILURES` | Failures (5xx, network failures, timeouts) within the window that open the circuit. |
| `http.services.<name>.circuitBreaker.window` | `record of duration` | `"30s"` | `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_WINDOW` | The rolling window failures are counted in. |
| `http.services.<name>.circuitBreaker.cooldown` | `record of duration` | `"30s"` | `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_COOLDOWN` | How long an open circuit rejects calls before one trial call. |
| `http.services.<name>.bulkhead.enabled` | `record of boolean` | `true` | `QS_HTTP_SERVICES_<NAME>_BULKHEAD_ENABLED` | Caps how many calls to the service run at once. Turns it off when false. |
| `http.services.<name>.bulkhead.concurrency` | `record of integer` | `10` | `QS_HTTP_SERVICES_<NAME>_BULKHEAD_CONCURRENCY` | Calls to the service running at once in a worker. |
| `http.services.<name>.bulkhead.queue` | `record of integer` | `100` | `QS_HTTP_SERVICES_<NAME>_BULKHEAD_QUEUE` | Calls waiting for a slot. |
| `http.services.<name>.bulkhead.queueTimeout` | `record of duration` | `"5s"` | `QS_HTTP_SERVICES_<NAME>_BULKHEAD_QUEUE_TIMEOUT` | The longest a call waits for a slot; the wait counts toward its timeout. |
| `http.services.<name>.cache.enabled` | `record of boolean` | `true` | `QS_HTTP_SERVICES_<NAME>_CACHE_ENABLED` | Keeps GET and HEAD responses of the service in memory, following its caching headers. Turns it off when false. |
| `http.services.<name>.cache.ttl` | `record of duration` | `"60s"` | `QS_HTTP_SERVICES_<NAME>_CACHE_TTL` | How long a response without max-age stays fresh. |
| `http.services.<name>.cache.maxTtl` | `record of duration` | `"1h"` | `QS_HTTP_SERVICES_<NAME>_CACHE_MAX_TTL` | The longest a response stays fresh, whatever its max-age. |
| `http.services.<name>.cache.maxEntries` | `record of integer` | `1000` | `QS_HTTP_SERVICES_<NAME>_CACHE_MAX_ENTRIES` | Responses kept per worker; the least recently used is evicted. |
| `http.services.<name>.cache.maxEntrySize` | `record of size` | `"1MB"` | `QS_HTTP_SERVICES_<NAME>_CACHE_MAX_ENTRY_SIZE` | The largest body stored; a larger one passes through. |
| `http.services.<name>.cache.private` | `record of boolean` | `false` | `QS_HTTP_SERVICES_<NAME>_CACHE_PRIVATE` | Caches calls with authorization or cookie headers, keyed by a hash of them, and Cache-Control: private responses. |
| `http.services.<name>.modifiers` | `record of string[]` | `[]` | `QS_HTTP_SERVICES_<NAME>_MODIFIERS` | Registered modifiers that wrap every call to the service, in order, inside the built-in ones. |
| `http.enabled` | `boolean` | `true` | `QS_HTTP_ENABLED` | Turns the feature off when false. |

### `tenancy`

Multi-tenancy: every request is resolved to a tenant from a header, a subdomain, a path prefix, the credentials or a function.

Every option, tag, command and hook of `tenancy` is on [its reference page](/reference/features/tenancy/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `tenancy.from` | `("header" \| "subdomain" \| "path" \| "auth" \| "function")[]` | `["header"]` | `QS_TENANCY_FROM` | Where the tenant id comes from, tried in this order: header, subdomain, path, auth (set by an authentication middleware) or function. |
| `tenancy.header` | `string` | `"x-tenant-id"` | `QS_TENANCY_HEADER` | The request header that carries the tenant id for the header source. |
| `tenancy.domain` | `string` | — | `QS_TENANCY_DOMAIN` | The base host of the subdomain source: acme.app.example.com is tenant acme when the domain is app.example.com. |
| `tenancy.path` | `string` | `"/t/[tenant]"` | `QS_TENANCY_PATH` | The path prefix of the path source, with a [tenant] segment; it is removed before routing. |
| `tenancy.resolve` | `string` | — | `QS_TENANCY_RESOLVE` | The function source: a function of the request and its user returning the tenant id or undefined; required when from lists function. |
| `tenancy.required` | `boolean` | `true` | `QS_TENANCY_REQUIRED` | Answers 400 to requests without a tenant on routes that are not exempt; @tenancy required=false relaxes one endpoint. |
| `tenancy.strategy` | `"schema" \| "database"` | `"schema"` | `QS_TENANCY_STRATEGY` | Where the data of tenants that set no strategy of their own lives: a schema of the service's database per tenant, or a database per tenant; a function of the tenant decides per tenant, once per tenant scope. |
| `tenancy.schema` | `string` | `"tenant-{tenant}"` | `QS_TENANCY_SCHEMA` | The schema name of schema-strategy tenants without their own: `{tenant}` is replaced by the tenant id. |
| `tenancy.pools.max` | `integer` | `50` | `QS_TENANCY_POOLS_MAX` | Most tenant database pools each worker keeps open; the least recently used idle one closes to make room. |
| `tenancy.pools.connections` | `integer` | `2` | `QS_TENANCY_POOLS_CONNECTIONS` | Connections of each tenant database pool, per worker. |
| `tenancy.pools.idle` | `duration` | `"5m"` | `QS_TENANCY_POOLS_IDLE` | How long an unused tenant database pool stays open. |
| `tenancy.pools.connectTimeout` | `duration` | `"10s"` | `QS_TENANCY_POOLS_CONNECT_TIMEOUT` | How long opening a tenant database may take before the request answers 503. |
| `tenancy.connection` | `string` | — | `QS_TENANCY_CONNECTION` | The connection of database-strategy tenants without their own: a text where `{tenant}` is replaced by the tenant id, like `postgres://app@db:5432/tenant_{tenant}`, or a function of the tenant. |
| `tenancy.connectionService` | `string` | — | `QS_TENANCY_CONNECTION_SERVICE` | The http.services entry asked for a tenant's connection as GET /tenants/:id/connection, after the other sources. |
| `tenancy.connectionCache.ttl` | `duration` | `"10m"` | `QS_TENANCY_CONNECTION_CACHE_TTL` | How long each worker keeps a resolved connection without a ttl of its own. |
| `tenancy.relay.interval` | `duration` | `"1m"` | `QS_TENANCY_RELAY_INTERVAL` | How often each worker relays the queue and outbox rows that database-strategy tenants staged in their open pools; delivery is at least once, delayed by up to this interval after a crash, so consumers must be idempotent. |
| `tenancy.beforeResolve` | `hook` | — | not overridable | Runs after the sources with the id found (or undefined), its source and the request; returning another id replaces it, null leaves the request without a tenant, and a throw refuses it with that error. |
| `tenancy.afterResolve` | `hook` | — | not overridable | Runs once a request's tenant is known and active, with the tenant and the request; a failure is logged. |
| `tenancy.onUnknownTenant` | `hook` | — | not overridable | Runs when the directory does not know a request's tenant id, before the 404. |
| `tenancy.onPoolOpen` | `hook` | — | not overridable | Runs after a tenant database pool opens. |
| `tenancy.onPoolClose` | `hook` | — | not overridable | Runs after a tenant database pool closes, with the reason: idle, evicted, shutdown, failed or changed. |
| `tenancy.directory` | `TenantDirectory` | — | not overridable | Replaces where tenants are looked up (the source), keeping the cache; the build then adds no Tenant entity. |
| `tenancy.resolver` | `TenantResolver` | — | not overridable | Replaces how a request's tenant id is found: its resolve method gets the request, its URL and its user and returns the id or undefined; the id rule and the mismatch check still apply. |
| `tenancy.scope` | `"tenant" \| "shared"` | `"tenant"` | `QS_TENANCY_SCOPE` | Whether an entity's records belong to one tenant or are shared by every tenant; set per entity with @tenancy shared. |
| `tenancy.source` | `"database" \| "config" \| "service"` | `"database"` | `QS_TENANCY_SOURCE` | Where tenants are looked up: the Tenant table of the service's database, the tenants option, or another service through the HTTP client. |
| `tenancy.tenants.<name>.plan` | `record of string` | — | `QS_TENANCY_TENANTS_<NAME>_PLAN` | The tenant's plan, in req.tenant.plan. |
| `tenancy.tenants.<name>.strategy` | `record of "schema" \| "database"` | — | `QS_TENANCY_TENANTS_<NAME>_STRATEGY` | Where the tenant's data lives, over tenancy.strategy. |
| `tenancy.tenants.<name>.schema` | `record of string` | — | `QS_TENANCY_TENANTS_<NAME>_SCHEMA` | The tenant's schema name, over the tenancy.schema template. |
| `tenancy.tenants.<name>.connection` | `record of string` | — | `QS_TENANCY_TENANTS_<NAME>_CONNECTION` | The connection of a database-strategy tenant. |
| `tenancy.tenants.<name>.status` | `record of "active" \| "suspended"` | `"active"` | `QS_TENANCY_TENANTS_<NAME>_STATUS` | A suspended tenant's requests answer 403. |
| `tenancy.tenants.<name>.attributes.<name>` | `record of record of string` | — | `QS_TENANCY_TENANTS_<NAME>_ATTRIBUTES_<NAME>` | One attribute of the tenant. |
| `tenancy.service` | `string` | — | `QS_TENANCY_SERVICE` | The http.services entry of the service source, called as GET /tenants/:id for one tenant and GET /tenants?cursor=… for pages. |
| `tenancy.cache.ttl` | `duration` | `"5m"` | `QS_TENANCY_CACHE_TTL` | How long each worker keeps a tenant it looked up. |
| `tenancy.cache.negativeTtl` | `duration` | `"30s"` | `QS_TENANCY_CACHE_NEGATIVE_TTL` | How long each worker remembers an unknown tenant id. |
| `tenancy.cache.staleTtl` | `duration` | `"1h"` | `QS_TENANCY_CACHE_STALE_TTL` | How long a cached tenant is still used while the directory fails. |
| `tenancy.cache.maxEntries` | `integer` | `10000` | `QS_TENANCY_CACHE_MAX_ENTRIES` | Most tenants each worker keeps; the least recently used go first. |
| `tenancy.enabled` | `boolean` | `true` | `QS_TENANCY_ENABLED` | Turns the feature off when false. |

#### `@tenancy`

`@tenancy shared` makes an entity's records shared by every tenant; on an endpoint, `@tenancy off` exempts it from tenant resolution and `@tenancy required=false` lets it run without a tenant.

**Applies to:** entities, endpoints

**Options:** `scope`, `required`

**Syntax:** `@tenancy <scope> [required=…]` or `@tenancy off`

```ts
/** @tenancy shared */
export type Plan = { name: string };
```

### `auth`

One authentication contract for every provider: the first provider that accepts a request's credentials fills req.user, req.auth and optionally req.tenant.

Every option, tag, command and hook of `auth` is on [its reference page](/reference/features/auth/).

| Key | Type | Default | Environment variable | Description |
| --- | --- | --- | --- | --- |
| `auth.required` | `boolean` | `false` | `QS_AUTH_REQUIRED` | Every route needs a signed-in user unless tagged @auth off; runtime routes registered with auth: false stay public. A function of the request, its user and tenant decides per request for the routes without an @auth tag, once the tenant is known. |
| `auth.scopes` | `string[]` | `[]` | `QS_AUTH_SCOPES` | The token scopes every route that needs a user requires, unless its @auth tag lists its own. |
| `auth.roles` | `string[]` | `[]` | `QS_AUTH_ROLES` | The roles every route requires, as role or role:operation entries like the @roles tag (admin, admin:delete); empty by default. |
| `auth.providers` | `AuthProvider[]` | `[]` | `QS_AUTH_PROVIDERS` | Authentication providers of the project, tried before the providers features register; each has a name, the credentials it reads and authenticate. |
| `auth.beforeUser` | `hook` | — | not overridable | Runs after a provider's result with the user, req.auth and the request; it may return a changed user (like roles loaded from the database), and a throw answers with that error. |
| `auth.onAuthenticated` | `hook` | — | not overridable | Runs once a request is authenticated, with the user, req.auth and the request; a failure is logged. |
| `auth.onAuthFailed` | `hook` | — | not overridable | Runs after credentials are refused with 401, with the provider, the reason and the request; a failure is logged. |
| `auth.beforeAuthorize` | `hook` | — | not overridable | Runs before the @auth and @roles checks of a route with the user, the route, its operation, roles and scopes and the request: true allows, false answers 403 Not allowed, undefined keeps the tag rules. |
| `auth.enabled` | `boolean` | `true` | `QS_AUTH_ENABLED` | Turns the feature off when false. |

#### `@auth`

`@auth` requires a signed-in user on every route of an entity or on one endpoint, `@auth scopes=posts:write` also requires token scopes, and `@auth off` keeps the target public when `required` is true.

**Applies to:** entities, endpoints

**Options:** `scopes`

**Syntax:** `@auth [scopes=…]` or `@auth off`

```ts
/** @auth */
export type Post = { title: string };
```

#### `@roles`

`@roles admin` requires one of the roles on every route of the target; on entities, `@roles admin:delete` restricts one operation (list, read, create, update, replace, delete) or a group (view, write).

**Applies to:** entities, endpoints

**Options:** `roles`

**Syntax:** `@roles <roles>` or `@roles off`

```ts
/** @roles editor:write,admin:delete */
export type Post = { title: string };
```
