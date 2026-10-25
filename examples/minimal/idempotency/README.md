# idempotency

The smallest project that shows the `idempotency` native: an `Order` entity whose create route requires an `Idempotency-Key`, and a `POST /payments` endpoint that charges once however often a client retries. Batch clients keep their keys for a week, the others for a day.

```bash
bun run test
```

The idempotency guide (`docs/src/content/docs/guides/idempotency.md`, on the site at `/guides/idempotency/`) explains every piece.

## Level 0: enable

Turn the native on; every `POST` route honors the `Idempotency-Key` header:

```ts
export default defineConfig({ database: memoryAdapter(), idempotency: {} });
```

## Level 1: options and environment

Every option has a default and a `QS_*` variable: the header, the methods, whether the key is required, how long responses are kept and the largest one stored:

```ts
idempotency: { methods: ["POST", "PUT"], maxResponseSize: "256KB" }
```

```bash
QS_IDEMPOTENCY_TTL=1h QS_IDEMPOTENCY_HEADER=X-Request-Key bun .generated/server.ts
```

## Level 2: tags

`@idempotent` on an entity applies to its create route and on an endpoint to that route, with `required` and `ttl` for that target; `@idempotent off` ignores keys:

```ts
/** @idempotent required=true */
export type Order = { item: string; quantity: number };
```

## Level 3: per request

`required` and `ttl` can be functions of the request, and `scope` replaces the user part of a key's scope:

```ts
idempotency: { ttl: ({ req }) => (req?.headers.get("x-client") === "batch" ? "7d" : "24h"), scope: ({ user }) => user?.tenant ?? "anonymous" }
```

## Level 4: hooks and events

`beforeReplay` (returning `false` runs the request again), `afterStore` and `onConflict` run around the keys:

```ts
idempotency: { onConflict: ({ req, kind }) => console.warn(`${kind} key on ${req.route}`) }
```

## Level 5: override files

Not applicable: the native contributes no endpoint, hook or job file, only the `IdempotencyKey` system entity.

## Level 6: replace the implementation

`store` keeps the keys elsewhere, like Redis; the build then adds no `IdempotencyKey` entity:

```ts
idempotency: { store: redisIdempotencyStore({ url: env.REDIS_URL }) }
```

## Level 7: eject

Copy the native into the project as a `features/idempotency/` project feature that replaces it:

```bash
quickservice eject idempotency
```
