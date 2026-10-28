# proxy

> Proxy routes: the service forwards the requests of configured paths to an upstream URL or a named service, streaming both ways, with timeouts and proxy headers.

Proxy routes: the service forwards the requests of configured paths to an upstream URL or a named service, streaming both ways, with timeouts and proxy headers.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
proxy: {}
```

It is not enabled by default: turn it on with `proxy: {}` or `QS_PROXY_ENABLED=true`, and off with `proxy: false` or `QS_PROXY_ENABLED=false`.

**Requires:** [`http`](/reference/features/http/) (proxy routes call their upstreams through the HTTP client)

**Runs after:** `auth`

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `proxy.identity.secret` | `string` | — | `QS_PROXY_IDENTITY_SECRET` | no | Signs every proxied request's forwarded identity with HMAC-SHA256, for proxyIdentity() in the upstream. |
| `proxy.identity.header` | `string` | `"x-quickservicets-identity"` | `QS_PROXY_IDENTITY_HEADER` | no | The header carrying the signed identity. |
| `proxy.identity.maxAge` | `duration` | `"60s"` | `QS_PROXY_IDENTITY_MAX_AGE` | no | How old a signed identity may be when the upstream checks it. |
| `proxy.routes.<name>.path` | `record of string` | — | `QS_PROXY_ROUTES_<NAME>_PATH` | no | The path the route serves: an exact path, or a prefix ending in /* like /billing/*. |
| `proxy.routes.<name>.target` | `record of url` | — | `QS_PROXY_ROUTES_<NAME>_TARGET` | no | The upstream's base URL; set this or service. |
| `proxy.routes.<name>.service` | `record of string` | — | `QS_PROXY_ROUTES_<NAME>_SERVICE` | no | The http.services entry the route calls, with its headers, authentication, TLS and modifiers; set this or target. |
| `proxy.routes.<name>.methods` | `record of string[]` | `["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]` | `QS_PROXY_ROUTES_<NAME>_METHODS` | no | The methods the route forwards. |
| `proxy.routes.<name>.timeout` | `record of duration` | `"30s"` | `QS_PROXY_ROUTES_<NAME>_TIMEOUT` | no | How long the upstream may take to send its response headers; longer answers 504. |
| `proxy.routes.<name>.idleTimeout` | `record of duration` | `"60s"` | `QS_PROXY_ROUTES_<NAME>_IDLE_TIMEOUT` | no | How long the upstream may pause between body chunks. |
| `proxy.routes.<name>.preserveHost` | `record of boolean` | `false` | `QS_PROXY_ROUTES_<NAME>_PRESERVE_HOST` | no | Sends the client's host header to the upstream instead of the upstream's own. |
| `proxy.routes.<name>.stripPrefix` | `record of boolean` | `false` | `QS_PROXY_ROUTES_<NAME>_STRIP_PREFIX` | no | Removes the route's prefix from the upstream path: /billing/invoices goes up as /invoices. |
| `proxy.routes.<name>.rewrite` | `record of string` | — | `QS_PROXY_ROUTES_<NAME>_REWRITE` | no | The upstream path as a template, with [...rest] for the rest of the path after the prefix, like /api/v2/[...rest]. |
| `proxy.routes.<name>.auth` | `record of "inherit" \| "public" \| "required"` | `"inherit"` | `QS_PROXY_ROUTES_<NAME>_AUTH` | no | Who may use the route: inherit follows auth.required, public allows anyone, required needs a signed-in user. |
| `proxy.routes.<name>.roles` | `record of string[]` | `[]` | `QS_PROXY_ROUTES_<NAME>_ROLES` | no | Roles of which the user needs one; answers 403 Not allowed otherwise. |
| `proxy.routes.<name>.scopes` | `record of string[]` | `[]` | `QS_PROXY_ROUTES_<NAME>_SCOPES` | no | Token scopes the credentials need, all of them; answers 403 Insufficient scope otherwise. |
| `proxy.routes.<name>.forward` | `record of ("user" \| "roles" \| "tenant" \| "authorization" \| "cookie")[]` | `["user","tenant"]` | `QS_PROXY_ROUTES_<NAME>_FORWARD` | no | What the upstream receives of the request's identity: user as x-user-id, roles as x-user-roles, tenant as x-tenant-id, and the incoming authorization or cookie headers. |
| `proxy.enabled` | `boolean` | `true` | `QS_PROXY_ENABLED` | no | Turns the feature off when false. |
