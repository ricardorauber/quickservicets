# proxy

The smallest gateway that shows the `proxy` native: `/catalog/*` goes to the catalog upstream of `scripts/catalog.ts` with its prefix stripped and a rate limit, and `/orders/*` goes to the orders upstream of `scripts/orders.ts` for signed-in users only, with the user and tenant forwarded in headers the gateway signs and the upstream verifies with `proxyIdentity`.

```bash
GATEWAY_SECRET=change-me bun run catalog &
GATEWAY_SECRET=change-me bun run orders &
bun run test
```

The API gateway guide (`docs/src/content/docs/guides/api-gateway.md`, on the site at `/guides/api-gateway/`) explains every piece.

## Level 0: enable

Declare a route with a path and a target; every default applies:

```ts
export default defineConfig({ database: memoryAdapter(), proxy: { routes: { billing: { path: "/billing/*", target: "http://billing.internal:8080" } } } });
```

## Level 1: options and environment

Each route takes `stripPrefix` or `rewrite`, `auth`, `roles`, `scopes`, `forward`, `rateLimit`, `cors`, `ip`, `maxBodySize`, `timeout`, `idleTimeout` and `preserveHost`, and `identity.secret` signs the forwarded identity:

```ts
proxy: {
  identity: { secret: process.env.GATEWAY_SECRET },
  routes: {
    catalog: { path: "/catalog/*", target: "http://127.0.0.1:4101", stripPrefix: true, rateLimit: { limit: "60/min" } },
    orders: { path: "/orders/*", target: "http://127.0.0.1:4102", auth: "required", forward: ["user", "tenant"] },
  },
}
```

Every option has a variable, per route too:

```bash
QS_PROXY_ROUTES_ORDERS_TARGET=http://orders.internal:8080 QS_PROXY_ROUTES_CATALOG_RATE_LIMIT_LIMIT=120/min bun .generated/server.ts
```

## Level 2: tags

Not applicable: proxy routes are configuration, not entity or endpoint files, so the proxy has no JSDoc tags; per-route settings are route options.

## Level 3: per request

A target function chooses the upstream per request, among the route's `allowedTargets`, like routing each tenant to its region:

```ts
orders: {
  path: "/orders/*",
  target: ({ tenant }) => (tenant?.attributes.region === "eu" ? "https://orders.eu.internal" : "https://orders.us.internal"),
  allowedTargets: ["https://orders.eu.internal", "https://orders.us.internal"],
}
```

## Level 4: hooks and events

`beforeProxy` may change the upstream request on the same origin or refuse it, `afterProxy` observes each answer and `onProxyError` each failure:

```ts
proxy: {
  beforeProxy: [({ upstream }) => void upstream.headers.set("x-gateway", "1")],
  afterProxy: [({ route, status, durationMs }) => console.log(JSON.stringify({ route, status, durationMs }))],
}
```

## Level 5: override files

A project endpoint on a route's path, or on a more specific path under its prefix, wins over it, and `proxyRequest` forwards with the route's settings:

```ts
// endpoints/orders/summary/get.ts
import { proxyRequest, type Repositories, type ServiceRequest } from "@quickservicets/core";

export default async (_repos: Repositories, req: ServiceRequest) => {
  const response = await proxyRequest(req, "orders");
  const answer = new Response(response.body, response);
  answer.headers.set("x-summary", "1");
  return answer;
};
```

## Level 6: replace the implementation

A `forwarder` replaces how upstreams are called, after authentication, identity headers, security options and hooks, like one recording every call:

```ts
const calls: string[] = [];
const forwarder = { forward: async ({ request, url }: { request: Request; url: string }) => (calls.push(`${request.method} ${url}`), fetch(request)) };

export default defineConfig({ database: memoryAdapter(), proxy: { forwarder, routes: { orders: { path: "/orders/*", target: "http://127.0.0.1:4102" } } } });
```

## Level 7: eject

Copy the native into the project, where it replaces the built-in one:

```bash
bunx quickservicets eject proxy
```
