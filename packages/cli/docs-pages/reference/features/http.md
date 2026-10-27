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
| `http.services.<name>.url` | `record of url` | — | `QS_HTTP_SERVICES_<NAME>_URL` | no | The service's base URL; call paths are joined to its path, like https://billing.internal/v1. |
| `http.services.<name>.headers.<name>` | `record of record of string` | — | `QS_HTTP_SERVICES_<NAME>_HEADERS_<NAME>` | no | The value of the header. |
| `http.services.<name>.auth.bearer` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BEARER` | no | Sends the token as authorization: Bearer. |
| `http.services.<name>.auth.basic.username` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BASIC_USERNAME` | no | The user name. |
| `http.services.<name>.auth.basic.password` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_BASIC_PASSWORD` | no | The password. |
| `http.services.<name>.auth.apiKey.header` | `record of string` | `"x-api-key"` | `QS_HTTP_SERVICES_<NAME>_AUTH_API_KEY_HEADER` | no | The header that carries the key. |
| `http.services.<name>.auth.apiKey.value` | `record of string` | — | `QS_HTTP_SERVICES_<NAME>_AUTH_API_KEY_VALUE` | no | The key. |
| `http.services.<name>.timeout` | `record of duration` | — | `QS_HTTP_SERVICES_<NAME>_TIMEOUT` | no | The timeout of calls to the service, instead of http.timeout. |
| `http.enabled` | `boolean` | `true` | `QS_HTTP_ENABLED` | no | Turns the feature off when false. |

## Feature API

Other features reach it with `ctx.feature("http")` in their setup, listing `http` in `requires` or `after`.

### `addService`

```ts
addService(name: string, options: ServiceOptionsInput): void;
```

Registers a named service during setup, under `<feature key>/<name>` (or the feature key itself when `name` is
it), with the options of `http.services`; its host is trusted by SSRF protection for calls through it.
