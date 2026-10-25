# idempotency

The smallest project that shows the `idempotency` native: an `Order` entity whose create route replays its first response when a client repeats a `POST` with the same `Idempotency-Key`.

```bash
bun run test
```

## Level 0: enable

Turn the native on; every `POST` route honors the `Idempotency-Key` header:

```ts
export default defineConfig({ database: memoryAdapter(), idempotency: {} });
```

## Level 1: options and environment

Every option has a default and a `QS_*` variable: the header, the methods, whether the key is required, how long responses are kept and the largest one stored:

```ts
idempotency: { ttl: "7d", maxResponseSize: "256KB" }
```

```bash
QS_IDEMPOTENCY_TTL=1h bun .generated/server.ts
```

## Level 2: tags

`@idempotent` on an entity applies to its create route and on an endpoint to that route, with `required` and `ttl` for that target; `@idempotent off` ignores keys:

```ts
/** @idempotent required=true ttl=7d */
export type Order = { item: string; quantity: number };
```

## Level 3: per request

Not applicable: no idempotency option is resolved per request yet.

## Level 4: hooks and events

Not applicable: the native declares no hook yet.

## Level 5: override files

Not applicable: the native contributes no endpoint, hook or job file, only the `IdempotencyKey` system entity.

## Level 6: replace the implementation

Not applicable: keys are stored only in the project's database so far.

## Level 7: eject

Copy the native into the project as a `features/idempotency/` project feature that replaces it:

```bash
quickservice eject idempotency
```
