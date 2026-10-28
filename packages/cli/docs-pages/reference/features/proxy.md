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

**Runs after:** `auth`, `security`, `realtime`

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `proxy.beforeProxy` | `hook` | — | not overridable | no | Runs before each upstream call with the request, the route and the upstream URL and headers; it may return a changed upstream on the same origin, or throw an HttpError to refuse. |
| `proxy.afterProxy` | `hook` | — | not overridable | no | Runs once the upstream answered, with the request, the route, the status, the headers and the duration. |
| `proxy.onProxyError` | `hook` | — | not overridable | no | Runs when an upstream call fails, with the request, the route and the error. |
| `proxy.forwarder` | `ProxyForwarder` | — | not overridable | no | Replaces how the gateway calls upstreams; authentication, identity headers, security options and hooks still apply. |
| `proxy.allowedTargets` | `url[]` | `[]` | `QS_PROXY_ALLOWED_TARGETS` | no | The upstream base URLs forward() may call with an inline target; any other origin answers 502. |
| `proxy.identity.secret` | `string` | — | `QS_PROXY_IDENTITY_SECRET` | no | Signs every proxied request's forwarded identity with HMAC-SHA256, for proxyIdentity() in the upstream. |
| `proxy.identity.header` | `string` | `"x-quickservicets-identity"` | `QS_PROXY_IDENTITY_HEADER` | no | The header carrying the signed identity. |
| `proxy.identity.maxAge` | `duration` | `"60s"` | `QS_PROXY_IDENTITY_MAX_AGE` | no | How old a signed identity may be when the upstream checks it. |
| `proxy.routes.<name>.path` | `record of string` | — | `QS_PROXY_ROUTES_<NAME>_PATH` | no | The path the route serves: an exact path, or a prefix ending in /* like /billing/*. |
| `proxy.routes.<name>.target` | `record of url` | — | `QS_PROXY_ROUTES_<NAME>_TARGET` | yes | The upstream's base URL; set this or service. A function of the request, its user and tenant chooses it per request, among allowedTargets. |
| `proxy.routes.<name>.allowedTargets` | `record of url[]` | `[]` | `QS_PROXY_ROUTES_<NAME>_ALLOWED_TARGETS` | no | The base URLs a target function may choose; any other origin answers 502. Required with a target function. |
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
| `proxy.routes.<name>.rateLimit.limit` | `record of rate` | — | `QS_PROXY_ROUTES_<NAME>_RATE_LIMIT_LIMIT` | no | The route's own limit, like 100/min, on top of the global one. |
| `proxy.routes.<name>.rateLimit.by` | `record of ("ip" \| "user" \| "tenant" \| "route")[]` | — | `QS_PROXY_ROUTES_<NAME>_RATE_LIMIT_BY` | no | What the route's limit counts by (default the global rateLimit.by). |
| `proxy.routes.<name>.cors.origins` | `record of string[]` | — | `QS_PROXY_ROUTES_<NAME>_CORS_ORIGINS` | no | The browser origins allowed to call the route. |
| `proxy.routes.<name>.cors.credentials` | `record of boolean` | — | `QS_PROXY_ROUTES_<NAME>_CORS_CREDENTIALS` | no | Allows credentialed requests from those origins. |
| `proxy.routes.<name>.cors.methods` | `record of string[]` | — | `QS_PROXY_ROUTES_<NAME>_CORS_METHODS` | no | The methods preflights allow. |
| `proxy.routes.<name>.cors.headers` | `record of string[]` | — | `QS_PROXY_ROUTES_<NAME>_CORS_HEADERS` | no | The request headers preflights allow. |
| `proxy.routes.<name>.ip.allow` | `record of cidr[]` | — | `QS_PROXY_ROUTES_<NAME>_IP_ALLOW` | no | Addresses served on the route, on top of the global lists. |
| `proxy.routes.<name>.ip.deny` | `record of cidr[]` | — | `QS_PROXY_ROUTES_<NAME>_IP_DENY` | no | Addresses refused on the route, on top of the global lists. |
| `proxy.routes.<name>.maxBodySize` | `record of size` | — | `QS_PROXY_ROUTES_<NAME>_MAX_BODY_SIZE` | no | The largest request body the route streams to the upstream; larger ones answer 413. |
| `proxy.routes.<name>.websocket` | `record of boolean` | `false` | `QS_PROXY_ROUTES_<NAME>_WEBSOCKET` | no | Proxies WebSocket upgrades on the route's path to the upstream (ws:// or wss://), with the route's checks and the limits of realtime.websockets; needs realtime: {}. |
| `proxy.enabled` | `boolean` | `true` | `QS_PROXY_ENABLED` | no | Turns the feature off when false. |

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `proxy.beforeProxy` | before | Runs before each upstream call with the request, the route and the upstream URL and headers; it may return a changed upstream on the same origin, or throw an HttpError to refuse. |
| `proxy.afterProxy` | after | Runs once the upstream answered, with the request, the route, the status, the headers and the duration. |
| `proxy.onProxyError` | on | Runs when an upstream call fails, with the request, the route and the error. |

## Tags

The proxy has no JSDoc tags: its routes are configuration, not entity or endpoint files, so per-route settings (authentication, forwarding, rate limits, CORS, address lists and body limits) are route options.

## Routes and variables

Every option of a route has its variable, with the route's name in upper case and hyphens as underscores: `QS_PROXY_ROUTES_<NAME>_TARGET`, `QS_PROXY_ROUTES_<NAME>_TIMEOUT`, `QS_PROXY_ROUTES_<NAME>_STRIP_PREFIX`, `QS_PROXY_ROUTES_<NAME>_RATE_LIMIT_LIMIT`; `QS_PROXY_ROUTES` sets the whole record as JSON. `proxyIdentity({ secret })` verifies the signed identity in services behind the gateway.

## WebSockets

A route with `websocket: true` (`QS_PROXY_ROUTES_<NAME>_WEBSOCKET`, which needs `realtime: {}`) proxies `GET` upgrades on its path to the upstream at `ws://` or `wss://`, while plain requests stay HTTP. The route's authentication, roles, scopes and security options, the origin check and `maxConnections` of `realtime.websockets` and `beforeProxy` run first and answer refusals as HTTP (401, 403 `Origin not allowed`, 503 `Too many open sockets`). The upstream receives the forwarded and signed identity headers and the client's `sec-websocket-protocol`, never the client's own identity headers; the client is upgraded only after the upstream handshake, with the upstream's subprotocol; a refusing or unreachable upstream answers 502 `Upstream request failed` and one that does not complete the handshake within `timeout` answers 504 `Upstream request timed out`, with `onProxyError` called. Frames are piped both ways keeping their type. Close codes: a close from either side reaches the other with its code and reason; 1009 `Message too big` closes both for a frame over `realtime.websockets.maxMessageSize`; 1001 `Idle timeout` closes both after `realtime.websockets.idleTimeout` without frames; 1014 `Bad gateway` closes the client when the upstream drops or fails; a client that drops closes the upstream with 1001; shutdown closes with 1001 `Server shutting down`. Proxied sockets count toward `maxConnections`, and each writes one request log entry when it closes with `proxy`, `durationMs`, `messagesIn`, `messagesOut` and `closeCode`. `forward(req, options)` proxies an upgrade request the same way and resolves a 101 response; without any route setting `websocket: true` (nor a ws.ts route), it throws `forward() received a WebSocket upgrade, but no proxy route sets websocket: true`. Bun's WebSocket handler is passed to the server only when a ws.ts route exists or a route sets `websocket: true`.

## forward() from code

`forward(req, options, overrides?)` from `@quickservicets/core` forwards the current request from any endpoint, hook or feature handler through the whole proxy pipeline (streaming, forwarding and identity headers with the signature, SSRF trust, timeouts, the hooks with `route: null` for inline calls, and the `forwarder`) and resolves the upstream `Response` for every status, so the caller can inspect it, read it or return it unchanged. `options` is a route name, whose `auth`, `roles` and `scopes` are checked first, or an inline object with exactly one of `service` (an `http.services` entry) and `target` (an origin of `proxy.allowedTargets`, any other answers 502 and logs `proxy.target.refused`), plus `path`, `stripPrefix` or `rewrite` (only one), `timeout`, `idleTimeout`, `preserveHost`, `forward` and `headers` (never hop-by-hop or identity headers); `overrides` takes the same keys except `service` and `target`. A timeout, a connection failure, an open circuit or a full bulkhead rejects with the `HttpError` (504, 502 or 503) a proxy route would answer. `proxy: {}` without routes is enough, `QS_PROXY_ALLOWED_TARGETS` takes the allowed targets comma-separated, each call writes an `http.call` entry (service `proxy/forward` for an inline target) and the request log adds `proxy: <route>` or `proxy: "forward"`. `proxyRequest(req, routeName, overrides)` is an alias of `forward(req, routeName, overrides)`.
