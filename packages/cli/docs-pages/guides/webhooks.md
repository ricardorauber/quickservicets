# Webhooks

> Let other systems subscribe to the service's events with the webhooks native, choosing which events are deliverable and managing subscriptions with their secrets per tenant.

A webhook tells another system that something happened, by calling a URL it registered. The `webhooks` native keeps those registrations as subscriptions: a URL, the event patterns it wants and a secret, scoped to its tenant. The options, variables, tags and setup API are listed on the [webhooks reference page](/reference/features/webhooks/).

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
