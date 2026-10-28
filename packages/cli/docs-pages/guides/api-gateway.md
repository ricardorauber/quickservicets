# API gateway

> Forward path prefixes to other services with the proxy native, streaming both ways, with rewriting, authentication, signed identity headers, security options per route, timeouts and every customization level.

A product grows into several services: a catalog, an orders service, a billing system. Clients should see one API, with one place that checks who they are, limits how much they call and keeps credentials away from services that do not need them. The `proxy` native turns a QuickService.ts service into that gateway: configured path prefixes are forwarded to upstream services, and the service keeps its own entities and endpoints next to them. The options, variables, hooks and contracts are listed on the [proxy reference page](/reference/features/proxy/).

The samples come from the example project `examples/minimal/proxy`: a catalog upstream and an orders upstream that trusts the identity the gateway signs.

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter, secret } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  env: { GATEWAY_SECRET: secret().optional().describe("Signs the identity the gateway forwards; the orders upstream verifies it.") },
  auth: {},
  proxy: {
    identity: { secret: process.env.GATEWAY_SECRET },
    routes: {
      // `bun run catalog` serves the catalog on port 4101; it gets /products for /catalog/products.
      catalog: { path: "/catalog/*", target: "http://127.0.0.1:4101", stripPrefix: true, rateLimit: { limit: "60/min" } },
      // `bun run orders` serves the orders on port 4102, trusting the signed user and tenant.
      orders: { path: "/orders/*", target: "http://127.0.0.1:4102", auth: "required", forward: ["user", "tenant"] },
    },
  },
});
```

## Routes, targets and services

`proxy.routes` is a record of named routes. Each has a `path`, exact (`/status`) or a prefix ending in `/*` (`/catalog/*`), and exactly one of:

- `target`: the upstream's base URL. The route becomes the service `proxy/<name>`, so SSRF protection trusts its host without an `http.allow` entry;
- `service`: an entry of `http.services`, whose headers, authentication, TLS and modifiers apply to every proxied call.

`methods` (every method by default) limits what the route forwards. Two routes whose paths overlap fail startup naming both. A project endpoint on the same method and path, or on a more specific path under a prefix (`endpoints/catalog/health/get.ts` under `/catalog/*`), wins over the route.

## Streaming

Bodies are never buffered: the request body streams to the upstream as it arrives, and the upstream's response streams back with its status and headers, so large uploads and downloads cost the gateway a few buffers, not their size. Redirects from the upstream are passed to the client as they are.

## Headers and what is never forwarded

The upstream receives `x-forwarded-for` (the trusted chain of `security.proxy` with the client address), `x-forwarded-proto`, `x-forwarded-host`, `x-request-id` and its own `host` (`preserveHost: true` keeps the client's). It never receives hop-by-hop headers (`connection` and those it lists, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `proxy-authorization`), and by default neither `cookie` nor `authorization`: credentials meant for the gateway stay there. Hop-by-hop headers are removed from responses too.

## Rewriting

Paths are forwarded unchanged by default. `stripPrefix: true` removes the route's prefix (`/catalog/products` goes up as `/products`), and `rewrite` is a template with `[...rest]` for the rest of the path (`/api/v2/[...rest]`); a route takes one or the other, and the query string is always kept.

## Authentication and identity forwarding

`auth` decides who may use a route: `inherit` follows `auth.required`, `public` lets anyone through, `required` needs a signed-in user; `roles` and `scopes` add the checks of `@roles` and `@auth scopes=`. They run before any upstream call, answering 401 or 403.

A client never claims an identity: its own `x-user-id`, `x-user-roles`, `x-tenant-id` and identity headers are always removed. `forward` (default `["user", "tenant"]`) adds the real `x-user-id` and `x-tenant-id`, and `roles`, `authorization` or `cookie` when listed.

With `identity.secret`, every proxied request also carries `x-quickservicets-identity: t=<unix seconds>,v1=<hex HMAC-SHA256>` over the time, the method, the upstream path and the forwarded user, roles and tenant. A QuickService.ts service behind the gateway trusts it with one provider, which checks the signature in constant time and its age (`maxAge`, 60 seconds):

```ts
export default defineConfig({ database, auth: { providers: [proxyIdentity({ secret: process.env.GATEWAY_SECRET! })] } });
```

A changed header, a wrong secret or an old signature answers 401 there. Any other upstream verifies it with the same HMAC.

## Security options

Routes are configuration, not files, so they cannot carry JSDoc tags; per-route security goes through route options instead, applied by the `security` native exactly like tags on an endpoint:

- `rateLimit: { limit: "60/min", by: ["user"] }`, on top of the global limit;
- `cors`: the gateway answers preflights itself without calling the upstream, and removes the upstream's own `access-control-*` headers so the browser sees one policy;
- `ip: { allow, deny }`;
- `maxBodySize`: streamed bodies are counted and a larger one answers 413, aborting the upstream call; without it the global `security.limits.body` applies.

Security headers are added to proxied responses only where the upstream did not set them. Any feature gives such options to its own routes with `ctx.feature("security").routeOptions(pattern, options)`.

## Forwarding from code with forward()

A route is not the only way in: `forward(req, options, overrides?)` from `@quickservicets/core` forwards the current request from any endpoint, hook or feature handler through the same pipeline (streaming both ways, hop-by-hop and forwarding headers, the forwarded and signed identity, SSRF trust, timeouts, the hooks and the `forwarder`) and resolves the upstream `Response`, for every status. `proxy: {}` without routes is enough.

```ts
// endpoints/products/get.ts
import { forward, type Repositories, type ServiceRequest } from "@quickservicets/core";

export default async (_repos: Repositories, req: ServiceRequest) => {
  const [items, stock] = await Promise.all([
    forward(req, { service: "catalog", path: "/items" }),
    forward(req, { target: "http://stock.internal:8080", path: "/levels" }),
  ]);
  if (!items.ok) return items; // the upstream's answer, unchanged
  return { items: await items.json(), stock: await stock.json() };
};
```

- `options` is a route name, like `forward(req, "orders")`: the route's settings apply, its `auth`, `roles` and `scopes` are checked before any upstream call, and `overrides` changes them for the call. An unknown name throws `Unknown proxy route <name>`.
- Or `options` is an inline object with exactly one of `service` (an `http.services` entry, with its headers, authentication and resilience) and `target`, plus `path` (replaces the request path; the query string is kept unless `path` has its own), `stripPrefix: "/dashboard"` or `rewrite: "/v2/[...rest]"` (only one of the three), `timeout`, `idleTimeout`, `preserveHost`, `forward` and `headers`. `headers` never sets hop-by-hop or identity headers.
- An inline `target` must be one of `proxy.allowedTargets` (`QS_PROXY_ALLOWED_TARGETS`, comma-separated), which SSRF protection trusts without an `http.allow` entry; any other origin answers 502 and logs `proxy.target.refused`, so code never becomes a way to reach arbitrary hosts.
- Hooks receive `route: null` for inline calls. A timeout, a connection failure, a refused target, an open circuit or a full bulkhead rejects with the `HttpError` (504, 502 or 503) a route would answer; uncaught, it answers the request the same way.
- The body streams to the upstream, so call `forward` before reading it: after `await req.json()` it throws `forward(): the request body was already read`.
- `proxyRequest(req, routeName, overrides)`, the earlier name, is an alias of `forward(req, routeName, overrides)`.

## Timeouts and error answers

`timeout` (30 seconds) bounds the time until the upstream's response headers and `idleTimeout` (60 seconds) the pauses between body chunks. A slow upstream answers 504 `GATEWAY_TIMEOUT` `Upstream request timed out`; a refused connection or an SSRF block 502 `BAD_GATEWAY` `Upstream request failed`; an open circuit or a full bulkhead 503. Outside production the answers carry the failing URL and error code.

## Retries and circuit breakers through services

A route with `service` uses that service's modifiers: retries (only for requests whose body can be replayed, so never for streamed uploads), the circuit breaker, the bulkhead and response caching, configured once in `http.services` for every call to that upstream.

## Observability

Each forwarded call writes an `http.call` log entry with the route's service (`proxy/catalog`), the inline service of a `forward()` call, or `proxy/forward` for an inline target, and the request log entry adds `proxy: <route>` (or `proxy: "forward"` for an inline call) once the response body ended. With a tracer, the server span covers the request and a client span each upstream attempt, carrying `traceparent` upstream; with a meter, the request and client durations are recorded; usage metrics count proxied routes like any other.

## Customization

Every level of customization, as `examples/minimal/proxy` shows:

- Level 0: a route with a path and a target works with every default.
- Level 1: every option has a variable, per route too: `QS_PROXY_ROUTES_ORDERS_TARGET`, `QS_PROXY_ROUTES_CATALOG_STRIP_PREFIX`, `QS_PROXY_ROUTES_CATALOG_RATE_LIMIT_LIMIT`, `QS_PROXY_IDENTITY_SECRET`, or the whole record as JSON in `QS_PROXY_ROUTES`.
- Level 2: the proxy has no tags; per-route settings are route options.
- Level 3: a target function `({ req, user, tenant }) => url` chooses the upstream per request, among `allowedTargets`; any other origin answers 502 and logs `proxy.target.refused`, so per-tenant routing never becomes a way to reach arbitrary hosts.
- Level 4: `beforeProxy` changes the upstream request (same origin) or refuses it, `afterProxy` observes each answer and `onProxyError` each failure.
- Level 5: a project endpoint wins over a route on its path, and `forward(req, "orders", overrides)` forwards with the route's settings, so the endpoint can add checks or change the response; `forward(req, { service, path })` calls an upstream without any route.
- Level 6: a `forwarder` replaces how upstreams are called, while authentication, identity headers, security options and hooks still apply.
- Level 7: `quickservicets eject proxy` copies the native into `features/proxy/`.

```ts
proxy: {
  beforeProxy: [({ upstream }) => void upstream.headers.set("x-gateway", "1")],
  routes: { orders: { path: "/orders/*", target: ({ tenant }) => regionOf(tenant), allowedTargets: [EU, US] } },
}
```

## When to use a dedicated gateway instead

The proxy native suits a service that is the front door of a few upstreams it knows, with the checks and identity it already has. Choose a dedicated gateway (Envoy, NGINX, Kong, a cloud API gateway) when you need hundreds of routes managed by another team, WebSocket or gRPC proxying at scale, consumer keys and plans across many APIs, request transformation languages, or TLS and routing for traffic that never reaches a QuickService.ts service.

Next: [Configuration](/guides/configuration/).
