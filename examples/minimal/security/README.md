# security

The smallest project that shows the `security` native, which every service has without asking: every response carries the standard security headers, each client address gets 1000 requests a minute, oversized and slow requests are refused, and logs never show secrets. This project opens CORS to its browser app, limits logins to five a minute, keeps the admin statistics on the private network, and logs created customers with their `@sensitive` tax id masked.

```bash
bun run test
```

The security guide (`docs/src/content/docs/guides/security.md`, on the site at `/guides/security/`) explains every item, the threat it addresses and how to tune it.

## Level 0: enable

Nothing to add: the native is enabled by default, with every item on. `security: false` removes it all, and `QS_SECURITY_ENABLED=false` does the same from the environment:

```ts
export default defineConfig({ database: memoryAdapter(), security: false });
```

## Level 1: options and environment

Every item is a switch with options, and every option has its variable. Raise the rate limit, or set it from the environment:

```ts
export default defineConfig({ database: memoryAdapter(), security: { rateLimit: { limit: "300/min" } } });
```

```bash
QS_SECURITY_RATE_LIMIT_LIMIT=300/min bun .generated/server.ts
```

## Level 2: tags

Endpoints and entities tune the items for themselves: the login endpoint has its own limit, the admin statistics answer only the private network, a field is kept out of logs, and an embeddable page sends none of the security headers:

```ts
/** @rateLimit 5/min */
const login: Endpoint<{ email: string; password: string }, { signedIn: string }> = async (_repos, req) => ({ signedIn: (await req.json()).email });

/** @ipAllow private,loopback */
const stats: Endpoint = async (repos) => ({ posts: await repos.posts.query().count() });

export type Customer = {
  name: string;
  /** @sensitive */
  taxId: string;
};

/** @securityHeaders off */
const embed: Endpoint = () => new Response("<p>Embeddable</p>", { headers: { "content-type": "text/html" } });
```

## Level 3: per request

The rate limit can be a function of the request, its user and tenant, evaluated once `req.user` is set by an auth middleware:

```ts
export default defineConfig({
  database: memoryAdapter(),
  security: {
    rateLimit: {
      by: ["user"],
      limit: ({ user }) => ((user as { plan?: string } | undefined)?.plan === "pro" ? "3000/min" : "300/min"),
    },
  },
});
```

## Level 4: hooks and events

Hooks observe refusals after they are decided, and an `error` middleware changes the response of a refusal:

```ts
export default defineConfig({
  database: memoryAdapter(),
  security: { rateLimit: { onLimited: ({ key, limit, route }) => console.warn("rate limited", { key, limit, route }) } },
  middleware: [
    {
      stage: "error",
      run: (error) =>
        error instanceof HttpError && error.code === "RATE_LIMITED" ? Response.json({ message: "Slow down, please" }, { status: 429 }) : undefined,
    },
  ],
});
```

## Level 5: override files

Not applicable: the native ships no endpoint, hook or job a project file could replace; its only entity, `RateLimitCounter`, is internal to the database store.

## Level 6: replace the implementation

A feature that runs after `security` replaces the rate limit counters, like a Redis store; `security.rateLimit.store` takes the same object in the config:

```ts
export default defineFeature({
  key: "counters",
  after: ["security"],
  setup(ctx) {
    ctx.feature("security").rateLimitStore(redisRateLimitStore(process.env.REDIS_URL!));
  },
});
```

## Level 7: eject

Copy the native into the project as `features/security/`, which then replaces it with the same behavior:

```bash
bun run quickservicets eject security
```
