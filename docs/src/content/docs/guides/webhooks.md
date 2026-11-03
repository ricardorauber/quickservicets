---
title: Webhooks
description: Let other systems subscribe to the service's events with the webhooks native, choosing which events are deliverable and managing subscriptions with their secrets per tenant.
sidebar:
  order: 62
---

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

## Tenants

With [multi-tenancy](/guides/multi-tenancy/), `create` records the current tenant, and every other call made in a tenant's scope (a request, a job or a consumer of that tenant) only sees that tenant's subscriptions: another tenant's id answers `Webhook subscription <id> not found`.
