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
| `http.services.<name>.modifiers` | `record of string[]` | `[]` | `QS_HTTP_SERVICES_<NAME>_MODIFIERS` | no | Registered modifiers that wrap every call to the service, in order, inside the built-in ones. |
| `http.enabled` | `boolean` | `true` | `QS_HTTP_ENABLED` | no | Turns the feature off when false. |

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
