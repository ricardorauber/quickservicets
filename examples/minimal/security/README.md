# security

The smallest project that shows the `security` native, which every service has without asking: every response carries the standard security headers, and its protections are separate items (`proxy`, `headers`, `files`, `cors`, `limits`, `timeouts`, `loadShedding`, `rateLimit`, `ip` and `masking`), each on by default, run in a fixed order before routing. A project feature exempts the load balancer's probe from the items that could refuse it.

```bash
bun run test
```

## Level 0: enable

Nothing to add: the native is enabled by default. `security: false` removes it all:

```ts
export default defineConfig({ database: memoryAdapter(), security: false });
```

## Level 1: options and environment

Each item is a switch; turn one off in the config or with its variable, and the whole feature with `QS_SECURITY_ENABLED=false`:

```ts
export default defineConfig({ database: memoryAdapter(), security: { cors: false } });
```

```bash
QS_SECURITY_CORS_ENABLED=false bun .generated/server.ts
QS_SECURITY_LIMITS_BODY=5MB bun .generated/server.ts
```

Every client address gets 1000 requests a minute; change the limit, or switch the rate limit off behind a gateway that already limits:

```ts
export default defineConfig({ database: memoryAdapter(), security: { rateLimit: { limit: "300/min" } } });
```

```bash
QS_SECURITY_RATE_LIMIT_LIMIT=300/min bun .generated/server.ts
```

Open CORS to the origins of the project's browser apps; it is closed by default:

```ts
export default defineConfig({ database: memoryAdapter(), security: { cors: { origins: ["http://localhost:5173"] } } });
```

Behind a load balancer, trust it so `req.ip` is the client's address from `x-forwarded-for` instead of the balancer's:

```ts
export default defineConfig({ database: memoryAdapter(), security: { proxy: { trust: ["10.0.0.0/8"] } } });
```

## Level 2: tags

`@rateLimit` gives a route its own limit on top of the global one, keyed by route and, here, by user:

```ts
/** @rateLimit 10/min by=user */
export default handler;
```

`@securityHeaders` changes the security headers of one endpoint or of an entity's routes, and `@securityHeaders off` sends none there:

```ts
/** @securityHeaders csp="default-src 'self'" */
export default handler;
```

`@cors` gives one route its own CORS options, like a partner origin with credentials:

```ts
/** @cors origins=https://partner.example credentials=true */
export default handler;
```

## Level 3: per request

The rate limit can be a function of the request, its user and tenant, evaluated once `req.user` is set:

```ts
export default defineConfig({
  database: memoryAdapter(),
  security: { rateLimit: { limit: ({ user }) => ((user as { plan?: string } | undefined)?.plan === "pro" ? "3000/min" : "300/min"), by: ["user"] } },
});
```

## Level 4: hooks and events

Not applicable: this version has no hook yet. A feature that runs after `security` can exempt paths from items in its setup:

```ts
export default defineFeature({
  key: "probes",
  after: ["security"],
  setup(ctx) {
    ctx.feature("security").exempt("/health/*", ["rateLimit", "loadShedding", "ip"]);
    ctx.app.route("GET", "/health/live", () => ({ status: "ok" }));
  },
});
```

## Level 5: override files

Not applicable: the native ships no endpoint, hook or job a project file could replace.

## Level 6: replace the implementation

Not applicable: this version has no provider option; a project feature with the key `security` replaces the whole native.

## Level 7: eject

Copy the native into the project as `features/security/`, which then replaces it:

```bash
bun run quickservice eject security
```
