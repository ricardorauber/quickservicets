---
title: Webhooks
description: Let other systems subscribe to the service's events with the webhooks native, choosing which events are deliverable and managing subscriptions with their secrets per tenant.
sidebar:
  order: 62
---

A webhook tells another system that something happened, by calling a URL it registered. The `webhooks` native keeps those registrations as subscriptions: a URL, the event patterns it wants and a secret, scoped to its tenant. It also receives webhooks from other services through `webhook.ts` endpoint files. The options, variables, tags and setup API are listed on the [webhooks reference page](/reference/features/webhooks/).

## Enable it

```ts
export default defineConfig({ database: memoryAdapter(), webhooks: {} });
```

`webhooks: {}` (or `QS_WEBHOOKS_ENABLED=true`) is enough: it turns on `events` and `queues` with their defaults when the project did not configure them, and adds the internal entity `WebhookSubscription` (table `webhook_subscriptions`, no generated routes), so on SQLite, PostgreSQL and MongoDB run `quickservicets migration add AddWebhooks` and `quickservicets migrate` once. Without the key, the native adds no entity, listener or queue.

## Deliverable events

Subscriptions only receive the events the project makes deliverable:

- the write events of entities tagged `@webhooks`: every operation by default, or the ones the tag lists;
- every event a pattern of the `events` option matches, like `invoice.*` for custom events or `*.created` for every entity's creates.

```ts
/** @webhooks created,updated */
export type Order = { status: string; total: number };
```

```ts
webhooks: { events: ["invoice.*"] }
```

`@webhooks off` keeps an entity's events out even when a pattern matches them. The native's own `webhook.*` events are never deliverable. `webhooks.entity.events` sets which operations a bare `@webhooks` tag delivers.

## Deliveries

Every deliverable event becomes one delivery per enabled subscription whose patterns match it and whose tenant is the event's tenant (tenant-less subscriptions only get tenant-less events). The deliveries are rows of the system entity `WebhookDelivery` (table `webhook_deliveries`), each handed to the `webhooks/deliver` queue, both written inside the transaction of the write that caused the event: they exist exactly when the write commits, and a rolled-back write delivers nothing.

The body is built once per event:

```json
{
  "id": "01J...",
  "type": "order.updated",
  "timestamp": "2026-11-03T10:00:00.000Z",
  "data": { "entity": "Order", "operation": "updated", "recordId": "01J...", "record": { "id": "01J...", "status": "paid" }, "changed": ["status"] }
}
```

`record` is the record after the write (before it, for a delete) without its `@hidden` and `@sensitive` fields; writes made by a cascade, a set-null, a pull or a touch add `cause` to `data`. Custom events carry their payload as `data`. A body over 256 KB is not sent: its delivery is stored `failed` with `Payload too large` and the native logs `webhook.delivery.too-large`.

Each worker keeps the enabled subscriptions in memory, reloaded every 30 seconds and right after it changes one, so matching reads no database; an event no subscription matches costs one lookup, and writes of entities neither tagged nor matched by `events` are not observed at all.

## Sending and signatures

Each delivery is sent by the `webhooks/deliver` queue as a `POST` of the stored body to the subscription's URL, signed by the [Standard Webhooks](https://www.standardwebhooks.com/) scheme:

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `user-agent` | `quickservicets-webhooks/<core version>` |
| `webhook-id` | The event's id, the same on every attempt |
| `webhook-timestamp` | The attempt's time in unix seconds |
| `webhook-signature` | `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`; while a rotated secret is still valid, the new and the old signatures separated by a space |

The subscription's `headers` are added, and never replace these. Receivers check the signature with `verifyWebhook` (or any Standard Webhooks library):

```ts
import { verifyWebhook } from "@quickservicets/core";

export async function receive(request: Request, secret: string): Promise<Response> {
  const body = await request.text();
  const valid = verifyWebhook({
    id: request.headers.get("webhook-id") ?? "",
    timestamp: request.headers.get("webhook-timestamp") ?? "",
    body,
    signature: request.headers.get("webhook-signature") ?? "",
    secrets: [secret],
  });
  return new Response(null, { status: valid ? 204 : 401 });
}
```

`signWebhook({ id, timestamp, body, secret })` produces the same `v1,` signature. Every attempt goes through the [HTTP client](/guides/http-client/) with SSRF protection checking the address again (a subscription's host is never trusted like a named service), with `delivery.timeout` (10 seconds), without following redirects (a 3xx fails with `Redirects are not followed`), and keeping at most `delivery.responseBodyLimit` (1 KB) of the answer in the delivery's `lastResponse`. A 2xx marks the delivery `succeeded`; any other status, a timeout, a network error or an SSRF block records `lastStatus` (0 without an answer), `lastError` and `durationMs`. A 410 also disables the subscription with `Receiver answered 410 Gone`, and deliveries of a disabled subscription end `failed` with `Subscription disabled` without a request. At most `delivery.concurrency` (10) attempts of one subscription run at once per worker, and each attempt logs `webhook.delivery.succeeded` or `webhook.delivery.failed` with the subscription, delivery, type, attempt, status and duration, never the body or headers.

## Retries and auto-disable

A failed attempt is retried by the native itself, as a new `webhooks/deliver` message with a `runAt` (the queue never retries these messages): after attempt `n`, the delivery goes back to `pending` with `nextAttemptAt` = now + entry `n` of `delivery.retrySchedule`, with up to ±10% jitter. The default `["5s", "5m", "30m", "2h", "5h", "10h", "10h"]` gives 8 attempts over about 27.6 hours; when the last one fails, the delivery is `failed` with its last status, error and response. The schedule takes 1 to 20 durations of at most `7d`, otherwise resolution fails with `Invalid webhooks.delivery.retrySchedule: expected 1 to 20 durations of at most 7d`.

```ts
webhooks: { delivery: { retrySchedule: ["10s", "1m", "10m", "1h"], disableAfter: "2d" } }
```

The first failure of a subscription after a success sets its `failingSince`, and any success clears it. A failure while `failingSince` is older than `delivery.disableAfter` (`5d`) disables the subscription with `Failing for more than 5d`, fails its pending deliveries with `Subscription disabled` and logs `webhook.subscription.disabled`. Re-enable it with `update(id, { enabled: true })` or `PATCH /webhooks/[id]`.

The native emits `webhook.delivery.succeeded`, `webhook.delivery.failed` (on the final failure) with `{ subscriptionId, deliveryId, eventId, type, attempt, status }`, and `webhook.subscription.disabled` with `{ subscriptionId, reason, tenant }`, so a listener can tell the owner:

```ts
import { listen } from "@quickservicets/core";

export default listen("webhook.subscription.disabled", async (event) => {
  console.warn("webhook disabled", event.payload.subscriptionId, event.payload.reason);
});
```

These events are never delivered as webhooks.

Delivery is at least once. A worker that shuts down during an attempt gives the message back: the delivery stays `delivering` and the next worker sends it again as the same attempt, with the same `webhook-id`. Receivers must deduplicate by `webhook-id`.

`webhooks.subscriptions.ping(id)` (and `POST /webhooks/[id]/ping` with the management routes) sends a signed `webhook.ping` event with `data: { subscriptionId }` at once, without a delivery, and answers `{ status, ok, durationMs }`; at most 10 pings per minute per subscription, then 429 `Too many requests`.

## Delivery log and resend

With the management routes, each subscription's deliveries are readable and can be sent again:

| Route | Answer |
| --- | --- |
| `GET /webhooks/[id]/deliveries` | The deliveries, newest first, with `limit`, `offset`, `status` and `type`: each one's `id`, `event`, `type`, `status`, `attempt`, `nextAttemptAt`, `lastStatus`, `lastError`, `durationMs`, `deliveredAt` and `createdAt` |
| `GET /webhooks/[id]/deliveries/[deliveryId]` | One delivery, with the `payload` sent and the `lastResponse` kept |
| `POST /webhooks/[id]/deliveries/[deliveryId]/resend` | Sends a `succeeded` or `failed` delivery again from attempt 0, with the same `webhook-id`, and answers 202 `{ id, status: "pending" }` |

A `pending` or `delivering` delivery answers 409 `Delivery is already scheduled`, a disabled subscription 409 `Subscription is disabled`, and more than 30 resends per minute for one subscription answer 429 `Too many requests`. From code, `webhooks.resend(deliveryId)`, `webhooks.deliveries(subscriptionId, { status, type, limit, offset })` and `webhooks.delivery(subscriptionId, deliveryId)` do the same in the caller's tenant scope.

The CLI reads and resends from the project's database:

```bash
quickservicets webhooks list
quickservicets webhooks deliveries <subscription> --status failed --limit 50
quickservicets webhooks resend <delivery>
quickservicets webhooks resend --subscription <id> --failed
```

`webhooks list` prints each subscription's id, URL host (never its query string), whether it is enabled, its tenant, `failingSince` and its deliveries per status over the last 24 hours; `resend` prints `Rescheduled <n> deliveries` and exits 1 with the messages above on an error.

Every worker that runs scheduled work deletes `succeeded` and `failed` deliveries older than `delivery.retention` (`30d`, `QS_WEBHOOKS_DELIVERY_RETENTION`) at startup and once an hour, in batches of 1000, logging `webhooks.cleanup` with the count; `pending` and `delivering` deliveries are never deleted by age.

## Subscriptions from code

`webhooks.subscriptions` from `@quickservicets/core` (and `ctx.feature("webhooks").subscriptions` in features) creates, lists, reads, changes and deletes subscriptions:

```ts
import { webhooks } from "@quickservicets/core";

const created = await webhooks.subscriptions.create({ url: "https://hooks.example/orders", events: ["order.created"] });
// created.secret is "whsec_..." and is never returned again.
```

- `create` generates the secret as `whsec_` and the base64 of 24 random bytes; `get` and `list` never show it.
- `rotateSecret(id)` returns a new secret and keeps the old one valid for 24 hours, so receivers can switch without missing deliveries.
- `update(id, { url, events, description, headers, enabled })` changes a subscription; enabling one clears why it was disabled.
- Each event pattern must match at least one deliverable event, otherwise the call fails with 400 and `Event <pattern> is not available for webhooks`.

The URL must be absolute, without credentials, and its address must pass the [SSRF protection](/guides/http-client/) of the HTTP client when the subscription is created or its URL changes; with `delivery.requireHttps` (on in production by default) it must use `https`. A refused URL answers 400 with `Must be an https URL`, `Must not contain credentials` or `Address is not allowed`.

## Management routes

With the [auth](/guides/authentication/) native enabled, users manage their subscriptions over HTTP under `routes.path` (default `/webhooks`):

| Route | Answer |
| --- | --- |
| `GET /webhooks` | The subscriptions, newest first, with `limit` (default 20, at most 100), `offset` and `enabled=true\|false` |
| `POST /webhooks` | `{ url, events, description?, headers? }` creates one and answers 201 with its `secret`, shown only here |
| `GET /webhooks/[id]` | One subscription |
| `PATCH /webhooks/[id]` | Changes `url`, `events`, `description`, `headers` or `enabled` |
| `DELETE /webhooks/[id]` | Deletes it and answers 204 |
| `POST /webhooks/[id]/rotate-secret` | `{ secret, previousSecretExpiresAt }`, the old secret valid for 24 more hours |

```bash
curl -X POST localhost:3000/webhooks -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"url":"https://hooks.example/orders","events":["order.created"]}'
```

Every route needs a user holding one of `routes.roles` (default `["admin"]`): anonymous calls answer 401 `Authentication required`, other users 403 `Not allowed`, and `roles: []` lets any signed-in user. `createdBy` records who created each subscription. Without `auth`, no route is registered and startup logs `webhooks.routes need authentication; enable auth or manage subscriptions with webhooks.subscriptions`; `routes: false` (or `QS_WEBHOOKS_ROUTES_ENABLED=false`) removes them while `webhooks.subscriptions` keeps working. `/openapi.json` documents them under the `webhooks` tag.

## Tenants

With [multi-tenancy](/guides/multi-tenancy/), `create` records the current tenant, and every other call made in a tenant's scope (a request, a job or a consumer of that tenant) only sees that tenant's subscriptions: another tenant's id answers `Webhook subscription <id> not found` from code and 404 `Webhook subscription not found` over HTTP.

## Incoming webhooks

A `webhook.ts` file in `endpoints/` is a `POST` route at its folder's path that receives webhooks from Stripe, GitHub, a Standard Webhooks sender or any service signing with an HMAC. It default-exports `defineWebhook`:

```ts
// endpoints/stripe/webhook.ts
import { defineWebhook, env, stripeSignature } from "@quickservicets/core";

export default defineWebhook<{ id: string; type: string; data: { object: { id: string } } }>({
  verify: stripeSignature({ secret: env.STRIPE_WEBHOOK_SECRET }),
  handle: async (event, ctx) => {
    if (event.type === "invoice.paid") await ctx.repos.invoices.update(event.data.object.id, { status: "paid" });
  },
});
```

The route reads the raw body (up to `incoming.maxBodySize`, `1MB`, and the route's `@limits`; a larger one answers 413) and checks its signature before the endpoint's hooks or `handle` run. A missing, malformed, wrong or expired signature answers 401 `INVALID_SIGNATURE` `Invalid webhook signature` and logs `webhook.incoming.rejected` with the route and the reason (`missing`, `malformed`, `mismatch` or `expired`), never the signature or the body. When `handle` resolves, the route answers 200 `{ "received": true }`; an `HttpError` it throws is answered as such, and any other error answers 500, so the sender retries.

| Verifier | Checks | Delivery id |
| --- | --- | --- |
| `stripeSignature({ secret, tolerance? })` | `Stripe-Signature` (`t=<unix>,v1=<hex>`), the HMAC-SHA256 of `<t>.<body>`, the timestamp within `tolerance` (default `incoming.tolerance`, `5m`) | the event's `id` |
| `githubSignature({ secret })` | `X-Hub-Signature-256` (`sha256=<hex>` of the HMAC-SHA256 of the body); `eventType` is `X-GitHub-Event` | `X-GitHub-Delivery` |
| `standardWebhookSignature({ secret, tolerance? })` | `webhook-id`, `webhook-timestamp` and `webhook-signature` with `verifyWebhook` | `webhook-id` |
| `hmacSignature({ header, secret, algorithm, encoding, prefix?, idHeader? })` | the HMAC (`sha1`, `sha256` or `sha512`, `hex` or `base64`) of the body in `header`, after removing `prefix` | `idHeader`, when given |

Every comparison runs in constant time. A `secret` is a text, a [secret reference](/guides/secrets/) (with `{tenant}` resolved for the request's tenant), a function `({ req, tenant }) => string`, or a list of them during a rotation, any one matching:

```ts
verify: hmacSignature({ header: "x-signature", secret: ({ tenant }) => partnerSecrets[tenant ?? "default"]!, algorithm: "sha256", encoding: "hex", prefix: "sha256=" }),
```

`handle(event, ctx)` gets the parsed JSON body and `ctx` with `req`, `repos`, `rawBody`, `headers`, `deliveryId`, `eventType` and `log`. Webhook routes are exempt from the CSRF item (senders sign their requests instead of sending cookies) and keep the global rate limit unless tagged `@rateLimit off`; `/openapi.json` documents them as `POST` with an `x-webhook: { verifier }` entry.

## Dedupe and asynchronous handling

Senders retry, so the same delivery can arrive twice. While `incoming.dedupe` is on (the default) and the project has a `webhook.ts` file, the build adds the system entity `WebhookReceipt` (table `webhook_receipts`), and each route keeps one receipt per delivery id and tenant:

- the first request inserts a `processing` receipt (locked for 60 seconds) before the hooks and `handle` run, and marks it `processed` when `handle` resolves or `failed` when it throws, so the sender's retry runs `handle` again;
- a repeat of a `processed` delivery answers 200 `{ "received": true, "duplicate": true }` without running hooks or `handle`, logging `webhook.incoming.duplicate`;
- a repeat while the first is still `processing` answers 409 `Webhook delivery is being processed` with `Retry-After: 5`; a receipt whose lock passed (its process stopped) is taken over.

Verifiers that know no delivery id (an `hmacSignature` without `idHeader`) skip dedupe, and the route logs `webhook.incoming.no-delivery-id` once. Every worker that runs scheduled work deletes receipts older than `incoming.dedupe.retention` (`7d`) every hour, logging `webhooks.receipts.cleanup`. `QS_WEBHOOKS_INCOMING_DEDUPE_ENABLED=false` turns dedupe off: no receipt is read or written.

A slow handler can run in the background, so the sender gets a fast answer:

```ts
export default defineWebhook({
  async: true,
  verify: stripeSignature({ secret: env.STRIPE_WEBHOOK_SECRET }),
  handle: async (event, ctx) => {
    await ctx.repos.payments.create({ stripeId: (event as { id: string }).id });
  },
});
```

The route verifies and deduplicates, then writes the receipt and a `webhooks/incoming` message in one transaction and answers 202 `{ "received": true }`; the consumer runs `handle` with the same context, except that `req` is undefined and `rawBody` is not kept, and marks the receipt `processed`, or `failed` while the queue retries it.
