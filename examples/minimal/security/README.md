# security

The smallest project that shows the `security` native, which every service has without asking: every response carries the standard security headers, each client address gets 1000 requests a minute, oversized and slow requests are refused, and logs never show secrets. This project opens CORS to its browser app, limits logins to five a minute, keeps the admin statistics on the private network, and logs created customers with their `@sensitive` tax id masked.

```bash
bun run test
```

The security guide (`docs/src/content/docs/guides/security.md`, on the site at `/guides/security/`) explains every item, the threat it addresses and how to tune it, and the mTLS guide (`docs/src/content/docs/guides/mtls.md`, at `/guides/mtls/`) covers HTTPS, client certificates and certificates for outgoing calls.

The `mtls` item is the only one off by default. `tests/mtls.test.ts` turns it on with throwaway certificates created at test time, and `bun scripts/certs.ts` writes a local CA, a server certificate and the clients `billing` and `reports` to `certs/` (git-ignored) to try it by hand. Each level below ends with its mTLS form.

## Level 0: enable

Nothing to add: the native is enabled by default, with every item on. `security: false` removes it all, and `QS_SECURITY_ENABLED=false` does the same from the environment:

```ts
export default defineConfig({ database: memoryAdapter(), security: false });
```

mTLS is the one item that stays off until you give it the authorities client certificates must chain to; it needs `server.tls`, since the service then serves HTTPS:

```ts
export default defineConfig({
  database: memoryAdapter(),
  server: { tls: { cert: "certs/server.crt", key: "certs/server.key" } },
  security: { mtls: { ca: ["certs/ca.crt"] } },
});
```

## Level 1: options and environment

Every item is a switch with options, and every option has its variable. Raise the rate limit, or set it from the environment:

```ts
export default defineConfig({ database: memoryAdapter(), security: { rateLimit: { limit: "300/min" } } });
```

```bash
QS_SECURITY_RATE_LIMIT_LIMIT=300/min bun .generated/server.ts
```

mTLS: every key has its variable too, so HTTPS and client certificates turn on without touching the config, and `QS_SECURITY_MTLS_ALLOW` takes a comma-separated allowlist:

```bash
QS_SERVER_TLS_CERT=certs/server.crt QS_SERVER_TLS_KEY=certs/server.key QS_SECURITY_MTLS_ENABLED=true QS_SECURITY_MTLS_CA=certs/ca.crt QS_SECURITY_MTLS_ALLOW=CN=billing bun .generated/server.ts
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

mTLS: in `mode: "optional"`, `@mtls` makes one route require a certificate, and `allow=` replaces the global allowlist there, like `endpoints/internal/sync/post.ts`:

```ts
/** @mtls allow=CN=billing */
const sync: Endpoint = (_repos, req) => ({ synced: true, by: req.client?.subject.commonName ?? null });
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

mTLS: the allowlist can be a function too, so each tenant lists the client identities it accepts:

```ts
security: {
  mtls: { ca: ["certs/ca.crt"], allow: ({ tenant }) => tenant?.attributes.clients?.split(",") ?? [] },
},
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

mTLS: `beforeClient` checks a verified certificate and may refuse it, `onRejected` sees every refusal with its reason, and `certificateAuth` turns certificates into users for `@auth` and `@roles`:

```ts
export default defineConfig({
  database: memoryAdapter(),
  auth: { providers: [certificateAuth({ user: (client) => ({ id: client.subject.commonName, roles: ["service"] }) })] },
  security: {
    mtls: {
      ca: ["certs/ca.crt"],
      beforeClient: ({ client }) => {
        if (client.validTo && client.validTo.getTime() - Date.now() < 86_400_000) throw new HttpError(403, "Certificate expires within a day");
      },
      onRejected: ({ reason, client }) => console.warn("mTLS refused", reason, client?.fingerprint256),
    },
  },
});
```

## Level 5: override files

Not applicable: the native ships no endpoint, hook or job a project file could replace; its only entity, `RateLimitCounter`, is internal to the database store.

mTLS ships no files to override either; the certificates of a local run come from the project's script:

```bash
bun scripts/certs.ts
```

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

mTLS: a `verifier` replaces the extra checks after the chain check, like a revocation list or a SPIFFE trust bundle; a reason string refuses with 403:

```ts
const revoked = new Set(["4f3a…"]);
export default defineConfig({
  database: memoryAdapter(),
  security: { mtls: { ca: ["certs/ca.crt"], verifier: { verify: ({ client }) => (revoked.has(client.serialNumber) ? "revoked" : true) } } },
});
```

## Level 7: eject

Copy the native into the project as `features/security/`, which then replaces it with the same behavior:

```bash
bun run quickservicets eject security
```

mTLS: the ejected `features/security/` keeps verifying client certificates, and the mTLS test passes against it unchanged:

```bash
bun test tests/mtls.test.ts
```
