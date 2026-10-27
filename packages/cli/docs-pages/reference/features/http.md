# http

> A fluent, typed client for calling other HTTP services, with timeouts, size limits and clear errors by default.

A fluent, typed client for calling other HTTP services, with timeouts, size limits and clear errors by default.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
http: {}
```

It is enabled by default; turn it off with `http: false` or `QS_HTTP_ENABLED=false`.

**Runs after:** `security`

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `http.timeout` | `duration` | `"10s"` | `QS_HTTP_TIMEOUT` | no | The longest an outgoing call may take, reading the response body included; a call sets its own with .timeout(). |
| `http.maxResponseSize` | `size` | `"10MB"` | `QS_HTTP_MAX_RESPONSE_SIZE` | no | The largest response body a call reads; a larger one fails the call with RESPONSE_TOO_LARGE. |
| `http.userAgent` | `string` | `"quickservicets/0.2.0"` | `QS_HTTP_USER_AGENT` | no | The user-agent header of every outgoing call, unless the call sets one. |
| `http.ssrf` | `boolean` | `true` | `QS_HTTP_SSRF` | no | Blocks calls to internal networks, the machine itself and cloud metadata endpoints, checking every resolved address and every redirect. |
| `http.allow` | `string[]` | `[]` | `QS_HTTP_ALLOW` | no | Addresses, CIDR blocks (or loopback, private, linklocal) and host names like billing.internal or *.internal that SSRF protection lets through. |
| `http.maxRedirects` | `integer` | `5` | `QS_HTTP_MAX_REDIRECTS` | no | How many redirects a call follows before it fails with TOO_MANY_REDIRECTS. |
| `http.log` | `"all" \| "errors" \| "off"` | `"all"` | `QS_HTTP_LOG` | no | Which calls write an http.call log entry: all of them, only failed calls and statuses of 400 and above, or none. |
| `http.beforeRequest` | `hook` | — | not overridable | no | Runs before every attempt next to the transport, with the request; it may return a changed request, and a throw cancels the call with that error. |
| `http.afterResponse` | `hook` | — | not overridable | no | Runs after every attempt that got a response, with the request, the response and the duration. |
| `http.onError` | `hook` | — | not overridable | no | Runs after every attempt that failed, with the request and the HttpClientError. |
| `http.transport` | `HttpTransport` | — | not overridable | no | Replaces how a request is sent: its fetch(request, context) gets a standard Request with the abort signal and the address SSRF protection validated, and resolves a Response. |
| `http.services.<name>.url` | `record of url` | — | `QS_HTTP_SERVICES_<NAME>_URL` | no | The service's base URL; call paths are joined to its path, like https://billing.internal/v1. |
| `http.services.<name>.headers.<name>` | `record of record of string` | — | `QS_HTTP_SERVICES_<NAME>_HEADERS_<NAME>` | no | The value of the header. |
| `http.services.<name>.auth.bearer` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BEARER` | no | Sends the token as authorization: Bearer. |
| `http.services.<name>.auth.basic.username` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BASIC_USERNAME` | no | The user name. |
| `http.services.<name>.auth.basic.password` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BASIC_PASSWORD` | no | The password. |
| `http.services.<name>.auth.apiKey.header` | `record of string` | `"x-api-key"` | `QS_HTTP_SERVICES_<NAME>_AUTH_API_KEY_HEADER` | no | The header that carries the key. |
| `http.services.<name>.auth.apiKey.value` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_API_KEY_VALUE` | no | The key. |
| `http.services.<name>.timeout` | `record of duration` | — | `QS_HTTP_SERVICES_<NAME>_TIMEOUT` | no | The timeout of calls to the service, instead of http.timeout. |
| `http.services.<name>.propagate` | `record of ("user" \| "tenant" \| "authorization")[]` | `[]` | `QS_HTTP_SERVICES_<NAME>_PROPAGATE` | no | What calls through req.http carry from the request: user sends x-user-id, tenant sends x-tenant-id, authorization forwards the incoming authorization header. |
| `http.services.<name>.log` | `record of "all" \| "errors" \| "off"` | — | `QS_HTTP_SERVICES_<NAME>_LOG` | no | Which calls to the service write http.call entries, instead of http.log. |
| `http.services.<name>.retry.enabled` | `record of boolean` | `true` | `QS_HTTP_SERVICES_<NAME>_RETRY_ENABLED` | no | Retries calls to the service that are safe to retry. Turns it off when false. |
| `http.services.<name>.retry.attempts` | `record of integer` | `3` | `QS_HTTP_SERVICES_<NAME>_RETRY_ATTEMPTS` | no | Attempts in total, the first included. |
| `http.services.<name>.retry.backoff` | `record of duration` | `"200ms"` | `QS_HTTP_SERVICES_<NAME>_RETRY_BACKOFF` | no | The first backoff, doubled for each next attempt, with full jitter. |
| `http.services.<name>.retry.maxBackoff` | `record of duration` | `"5s"` | `QS_HTTP_SERVICES_<NAME>_RETRY_MAX_BACKOFF` | no | The longest backoff. |
| `http.services.<name>.retry.methods` | `record of ("GET" \| "HEAD" \| "OPTIONS" \| "PUT" \| "DELETE" \| "POST" \| "PATCH")[]` | `["GET","HEAD","OPTIONS","PUT","DELETE"]` | `QS_HTTP_SERVICES_<NAME>_RETRY_METHODS` | no | The methods retried; POST and PATCH are also retried when the request has an Idempotency-Key header. |
| `http.services.<name>.retry.on` | `record of (integer \| "NETWORK" \| "TIMEOUT")[]` | `[408,429,502,503,504,"NETWORK","TIMEOUT"]` | `QS_HTTP_SERVICES_<NAME>_RETRY_ON` | no | The statuses and error codes retried. |
| `http.services.<name>.retry.maxRetryAfter` | `record of duration` | `"30s"` | `QS_HTTP_SERVICES_<NAME>_RETRY_MAX_RETRY_AFTER` | no | The longest Retry-After waited; a longer one is not retried. |
| `http.services.<name>.circuitBreaker.enabled` | `record of boolean` | `true` | `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_ENABLED` | no | Stops calling the service for a while after repeated failures. Turns it off when false. |
| `http.services.<name>.circuitBreaker.failures` | `record of integer` | `5` | `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_FAILURES` | no | Failures (5xx, network failures, timeouts) within the window that open the circuit. |
| `http.services.<name>.circuitBreaker.window` | `record of duration` | `"30s"` | `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_WINDOW` | no | The rolling window failures are counted in. |
| `http.services.<name>.circuitBreaker.cooldown` | `record of duration` | `"30s"` | `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_COOLDOWN` | no | How long an open circuit rejects calls before one trial call. |
| `http.services.<name>.bulkhead.enabled` | `record of boolean` | `true` | `QS_HTTP_SERVICES_<NAME>_BULKHEAD_ENABLED` | no | Caps how many calls to the service run at once. Turns it off when false. |
| `http.services.<name>.bulkhead.concurrency` | `record of integer` | `10` | `QS_HTTP_SERVICES_<NAME>_BULKHEAD_CONCURRENCY` | no | Calls to the service running at once in a worker. |
| `http.services.<name>.bulkhead.queue` | `record of integer` | `100` | `QS_HTTP_SERVICES_<NAME>_BULKHEAD_QUEUE` | no | Calls waiting for a slot. |
| `http.services.<name>.bulkhead.queueTimeout` | `record of duration` | `"5s"` | `QS_HTTP_SERVICES_<NAME>_BULKHEAD_QUEUE_TIMEOUT` | no | The longest a call waits for a slot; the wait counts toward its timeout. |
| `http.services.<name>.cache.enabled` | `record of boolean` | `true` | `QS_HTTP_SERVICES_<NAME>_CACHE_ENABLED` | no | Keeps GET and HEAD responses of the service in memory, following its caching headers. Turns it off when false. |
| `http.services.<name>.cache.ttl` | `record of duration` | `"60s"` | `QS_HTTP_SERVICES_<NAME>_CACHE_TTL` | no | How long a response without max-age stays fresh. |
| `http.services.<name>.cache.maxTtl` | `record of duration` | `"1h"` | `QS_HTTP_SERVICES_<NAME>_CACHE_MAX_TTL` | no | The longest a response stays fresh, whatever its max-age. |
| `http.services.<name>.cache.maxEntries` | `record of integer` | `1000` | `QS_HTTP_SERVICES_<NAME>_CACHE_MAX_ENTRIES` | no | Responses kept per worker; the least recently used is evicted. |
| `http.services.<name>.cache.maxEntrySize` | `record of size` | `"1MB"` | `QS_HTTP_SERVICES_<NAME>_CACHE_MAX_ENTRY_SIZE` | no | The largest body stored; a larger one passes through. |
| `http.services.<name>.cache.private` | `record of boolean` | `false` | `QS_HTTP_SERVICES_<NAME>_CACHE_PRIVATE` | no | Caches calls with authorization or cookie headers, keyed by a hash of them, and Cache-Control: private responses. |
| `http.services.<name>.modifiers` | `record of string[]` | `[]` | `QS_HTTP_SERVICES_<NAME>_MODIFIERS` | no | Registered modifiers that wrap every call to the service, in order, inside the built-in ones. |
| `http.enabled` | `boolean` | `true` | `QS_HTTP_ENABLED` | no | Turns the feature off when false. |

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `http.beforeRequest` | before | Runs before every attempt next to the transport, with the request; it may return a changed request, and a throw cancels the call with that error. |
| `http.afterResponse` | after | Runs after every attempt that got a response, with the request, the response and the duration. |
| `http.onError` | on | Runs after every attempt that failed, with the request and the HttpClientError. |

## Feature API

Other features reach it with `ctx.feature("http")` in their setup, listing `http` in `requires` or `after`.

### `addService`

```ts
addService(name: string, options: ServiceOptionsInput): void;
```

Registers a named service during setup, under `<feature key>/<name>` (or the feature key itself when `name` is
it), with the options of `http.services`; its host is trusted by SSRF protection for calls through it.

### `modifier`

```ts
modifier(name: string, modifier: HttpModifier): void;
```

Registers a named modifier during setup, which services list in `modifiers`; a name registered twice fails
startup naming both owners.

### `beforeRequest`

```ts
beforeRequest(fn: FeatureHook<HttpRequest, undefined>): void;
```

Appends a `beforeRequest` hook after the config's: it may return a changed request, and a throw cancels the call.

### `afterResponse`

```ts
afterResponse(fn: FeatureHook<{ request: HttpRequest; response: HttpResponse; durationMs: number }, undefined>): void;
```

Appends an `afterResponse` hook, run after every attempt that got a response.

### `onError`

```ts
onError(fn: FeatureHook<{ request: HttpRequest; error: HttpClientError }, undefined>): void;
```

Appends an `onError` hook, run after every attempt that failed.

## Named services

Every option of a service has its variable, with the service's name in upper case and hyphens as underscores: `QS_HTTP_SERVICES_<NAME>_URL`, `QS_HTTP_SERVICES_<NAME>_TIMEOUT`, `QS_HTTP_SERVICES_<NAME>_AUTH_BEARER`, `QS_HTTP_SERVICES_<NAME>_RETRY_ENABLED`, `QS_HTTP_SERVICES_<NAME>_CIRCUIT_BREAKER_FAILURES`; `QS_HTTP_SERVICES` sets the whole record as JSON. A variable replaces a per-request function of `headers` or `auth`.

## Modifiers

A modifier wraps calls: `defineModifier((request, next) => ...)` receives the request (`method`, `url`, `headers`, `body`, `timeout`, `signal`, `attempt`, `service`), may change it, calls `next(request?)` any number of times and resolves the response or a replacement. Anything it throws other than an `HttpClientError` fails the call with `MODIFIER_FAILED`.

Calls run a service's built-in modifiers in the order `retry`, `circuitBreaker`, `bulkhead`, `cache`, then the service's `modifiers` list, then the call's `.use()` modifiers, then the transport with the hooks around it.

Registered names: `retry` (`withRetry`), `circuitBreaker` (`withCircuitBreaker`), `bulkhead` (`withBulkhead`) and `cache` (`withCache`); features add more with `ctx.feature("http").modifier(name, modifier)`.

## HttpTransport

`transport` replaces how a request is sent: an object with `fetch(request, { signal, address })` that receives a standard `Request` for the original URL and the address SSRF protection validated (absent with `ssrf: false`), and resolves a standard `Response`. Redirects, size limits, logging and modifiers keep working above it, and `http.mock()` answers instead while it is active.

## Tags

The client has no tags: calls are made from code, where every setting is a builder method or a service option.

## Files

The client contributes no entities, endpoints, hooks, jobs or folders, so there are no files to override.
