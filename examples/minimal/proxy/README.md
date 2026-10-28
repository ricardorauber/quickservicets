# proxy

The smallest gateway that shows the `proxy` native: requests under `/catalog/*` are forwarded to the catalog upstream of `scripts/catalog.ts`, streaming both ways, with `x-forwarded-*` headers and the upstream's own `host`.

```bash
bun run catalog &
bun run test
```

## Level 0: enable

Declare a route with a path and a target:

```ts
export default defineConfig({ database: memoryAdapter(), proxy: { routes: { catalog: { path: "/catalog/*", target: "http://127.0.0.1:4101" } } } });
```

## Level 1: options and environment

`methods`, `timeout`, `idleTimeout` and `preserveHost` tune each route, `service` calls a named service of `http.services` with its headers, authentication and modifiers instead of a target, and every option has a `QS_*` variable:

```ts
proxy: { routes: { billing: { path: "/billing/*", service: "billing", timeout: "10s" } } }
```

```bash
QS_PROXY_ROUTES_CATALOG_TARGET=http://catalog.internal:8080 bun .generated/server.ts
```

## Level 2: tags

Not applicable: proxy routes are configuration, not entity or endpoint files, so the proxy has no JSDoc tags.

## Level 3: per request

Not applicable: the proxy has no per-request options yet.

## Level 4: hooks and events

Not applicable: the proxy has no hooks yet; each forwarded call writes an `http.call` log entry with the route's service.

## Level 5: override files

A project endpoint on a proxy route's method and path, or on a more specific path under its prefix, wins over it:

```ts
// endpoints/catalog/health/get.ts
export default () => ({ status: "ok" });
```

## Level 6: replace the implementation

Not applicable: the proxy has no replaceable forwarder yet.

## Level 7: eject

Copy the native into the project, where it replaces the built-in one:

```bash
bunx quickservicets eject proxy
```
