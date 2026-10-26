# Idempotency keys

> Let clients retry a POST safely, a payment or an order, by sending an Idempotency-Key that makes a repeated request return the first response instead of running twice.

Networks fail between a client and a service: a client sends `POST /payments`, the connection drops, and the client cannot know whether the payment happened. Retrying may charge twice; not retrying may lose the payment. With the `idempotency` native, the client sends an `Idempotency-Key` header with a unique value and retries with the same value: the first request runs, and every repeat gets the first response back, without running the hooks or the handler again. The options, variables, tag, hooks and store are listed on the [idempotency reference page](/reference/features/idempotency/).

The samples come from the example project `examples/minimal/idempotency`: an `Order` entity whose create route requires a key, and a `POST /payments` endpoint that charges once however often it is retried.

## The header

With `idempotency: {}`, every `POST` route honors the header (`methods` adds `PUT`, `PATCH` or `DELETE`). The key is 1 to 255 visible ASCII characters, usually a UUID the client generates for one operation; anything else is `400 Invalid Idempotency-Key header`. A request without the header runs normally, unless `required` applies, which answers `400 Idempotency-Key header is required`.

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  idempotency: {
    // Batch clients may retry for a week; the others for a day.
    ttl: ({ req }) => (req?.headers.get("x-client") === "batch" ? "7d" : "24h"),
  },
});
```

## Scope and fingerprint

A key is scoped to the method, the route pattern and the user (`req.user?.id`, or `anonymous`): two users sending the same key, or one user sending it to two routes, never share a response. The first request also records a fingerprint, a SHA-256 of the method, path, sorted query string and raw body bytes.

## Replay

The first request of a scope stores a `running` record through a unique index before the handler runs, so two concurrent requests can never both run it. When the handler finishes, its response is stored, and a repeat with the same fingerprint gets the same status, body and `content-type`, `location` and `etag` headers, plus `Idempotent-Replayed: true`:

```ts title="endpoints/payments/post.ts"
import type { ServiceRequest, ServiceResponse } from "@quickservicets/core";

/** Charges a card; a retried request with the same Idempotency-Key gets the first charge back instead of a second one. */
export default async (_repos: unknown, req: ServiceRequest, res: ServiceResponse) => {
  const { amount } = (await req.json()) as { amount: number };
  // The payment provider takes a moment to answer.
  await Bun.sleep(100);
  res.status(201);
  return { paymentId: crypto.randomUUID(), amount };
};
```

## The 409 and 422 answers

| Answer | When | What the client does |
| --- | --- | --- |
| `409 IDEMPOTENCY_KEY_IN_USE` with `Retry-After: 1` | The first request with the key is still running | Wait a second and retry with the same key |
| `422 IDEMPOTENCY_KEY_REUSED` | The key was used with a different request (another body, path or query) | Fix the client: one key per operation |

A record left `running` by a process that crashed keeps others away for 60 seconds, then the next request takes it over.

## What is stored and released

Responses with a 2xx or 4xx status and a JSON or text body up to `maxResponseSize` (default `1MB`) are stored and replayed: a `400` validation error is the answer to that request too. A 5xx, an error thrown out of the pipeline, a streamed or file body, or a larger body releases the key instead, so a retry runs the handler again.

## Expiry

A stored response is replayed for `ttl` (default `24h`); after that the key runs again as a new request, even before the hourly cleanup deletes the record. Keep the `ttl` longer than the longest time a client keeps retrying.

## Tags

`@idempotent` turns keys on for one target: on an entity, its create route; on an endpoint, that route whatever its method. Its `required` and `ttl` win over the options there, and `@idempotent off` ignores keys:

```ts title="entities/Order.ts"
/** @idempotent required=true */
export type Order = {
  item: string;
  quantity: number;
};
```

## Per-request options

`required` and `ttl` can be functions of the request, its user and tenant, like the example's longer `ttl` for batch clients. `scope` replaces the user part of the scope, so the users of one tenant can share keys:

```ts
idempotency: { scope: ({ user }) => user?.tenant ?? "anonymous" }
```

## Hooks

`beforeReplay` receives `{ req, record }` before a replay; returning `false` deletes the record and runs the request again. `afterStore` observes each stored response and `onConflict` each refusal, with `kind` `reused` or `inUse`; other features add them with `ctx.feature("idempotency").addHook`.

```ts
idempotency: { onConflict: ({ req, kind }) => console.warn(`${kind} key on ${req.route}`) }
```

## The store

Keys live in the `IdempotencyKey` table of the project's database. `store` replaces it with any object with `begin`, `complete`, `release` and `cleanup`, like a Redis store; the build then adds no `IdempotencyKey` entity.

## Client-side retries

- Generate one key per operation (a UUID), keep it with the operation, and send it on every attempt; never reuse it for another operation.
- Retry on network errors, `409` (after `Retry-After`) and 5xx, with exponential backoff and a limit; never on `422`.
- Keep retrying no longer than the `ttl`, or the operation may run again.
- Treat a replayed response like the original one: `Idempotent-Replayed: true` only says it was stored.

## See also

- [Idempotency reference](/reference/features/idempotency/): every option with its variable, the tag, the hooks and the store.
- [A safe checkout](/recipes/safe-checkout/): a checkout a client retries without paying twice.
- [Queues](/guides/queues/): dedupe for background work with `dedupeKey`.
