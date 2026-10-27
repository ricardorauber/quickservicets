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
| `http.enabled` | `boolean` | `true` | `QS_HTTP_ENABLED` | no | Turns the feature off when false. |
