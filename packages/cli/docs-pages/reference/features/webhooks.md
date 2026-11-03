# webhooks

> Outgoing webhooks signed by the Standard Webhooks scheme for the events subscriptions choose, and incoming webhook routes.

Outgoing webhooks signed by the Standard Webhooks scheme for the events subscriptions choose, and incoming webhook routes.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
webhooks: {}
```

It is not enabled by default: turn it on with `webhooks: {}` or `QS_WEBHOOKS_ENABLED=true`, and off with `webhooks: false` or `QS_WEBHOOKS_ENABLED=false`.

**Requires:** [`http`](/reference/features/http/)

**Enables:** `events`, `queues`

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `webhooks.events` | `string[]` | `[]` | `QS_WEBHOOKS_EVENTS` | no | Event patterns subscriptions may receive besides the write events of entities tagged @webhooks, like invoice.* or *.created; custom events are deliverable only through them. |
| `webhooks.entity.events` | `("created" \| "updated" \| "deleted")[]` | `["created","updated","deleted"]` | `QS_WEBHOOKS_ENTITY_EVENTS` | no | The write operations an entity tagged @webhooks delivers when its tag lists none: created, updated and deleted. |
| `webhooks.routes.enabled` | `boolean` | `true` | `QS_WEBHOOKS_ROUTES_ENABLED` | no | The HTTP routes that manage subscriptions, which need the auth native. Turns it off when false. |
| `webhooks.routes.path` | `string` | `"/webhooks"` | `QS_WEBHOOKS_ROUTES_PATH` | no | Where the subscription management routes are served. |
| `webhooks.routes.roles` | `string[]` | `["admin"]` | `QS_WEBHOOKS_ROUTES_ROLES` | no | The roles that may manage subscriptions over HTTP; an empty list lets any signed-in user. |
| `webhooks.delivery.timeout` | `duration` | `"10s"` | `QS_WEBHOOKS_DELIVERY_TIMEOUT` | no | The longest one delivery attempt may take. |
| `webhooks.delivery.retrySchedule` | `duration[]` | `["5s","5m","30m","2h","5h","10h","10h"]` | `QS_WEBHOOKS_DELIVERY_RETRY_SCHEDULE` | no | The delays before each retry of a failed delivery, from 1 to 20 durations of at most 7d. |
| `webhooks.delivery.disableAfter` | `duration` | `"5d"` | `QS_WEBHOOKS_DELIVERY_DISABLE_AFTER` | no | How long a subscription may keep failing before it is disabled. |
| `webhooks.delivery.responseBodyLimit` | `size` | `"1KB"` | `QS_WEBHOOKS_DELIVERY_RESPONSE_BODY_LIMIT` | no | How much of a receiver's response body each attempt keeps. |
| `webhooks.delivery.retention` | `duration` | `"30d"` | `QS_WEBHOOKS_DELIVERY_RETENTION` | no | How long finished deliveries are kept. |
| `webhooks.delivery.requireHttps` | `boolean` | — | `QS_WEBHOOKS_DELIVERY_REQUIRE_HTTPS` | no | Accepts only https subscription URLs; true in production and false otherwise by default. |
| `webhooks.delivery.concurrency` | `integer` | `10` | `QS_WEBHOOKS_DELIVERY_CONCURRENCY` | no | How many attempts of one subscription run at once in one process. |
| `webhooks.incoming.tolerance` | `duration` | `"5m"` | `QS_WEBHOOKS_INCOMING_TOLERANCE` | no | How far a signed timestamp of an incoming webhook may be from now. |
| `webhooks.incoming.maxBodySize` | `size` | `"1MB"` | `QS_WEBHOOKS_INCOMING_MAX_BODY_SIZE` | no | The largest body an incoming webhook route reads. |
| `webhooks.incoming.dedupe.enabled` | `boolean` | `true` | `QS_WEBHOOKS_INCOMING_DEDUPE_ENABLED` | no | Processes each incoming delivery id once, keeping a receipt per delivery. Turns it off when false. |
| `webhooks.incoming.dedupe.retention` | `duration` | `"7d"` | `QS_WEBHOOKS_INCOMING_DEDUPE_RETENTION` | no | How long receipts of processed deliveries are kept. |
| `webhooks.enabled` | `boolean` | `true` | `QS_WEBHOOKS_ENABLED` | no | Turns the feature off when false. |
| `webhooks.database` | `string` | — | `QS_WEBHOOKS_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |

## Entities

With named databases ([`databases`](/reference/config/)), each entity of the feature lives in one place; `webhooks.database` (`QS_WEBHOOKS_DATABASE`) moves the entities that live in the feature's database.

| Entity | Database | Description |
| --- | --- | --- |
| `WebhookSubscription` | the feature's `database` (default: the default database) | The subscriptions: a URL, the event patterns, the secret and the tenant. |
| `WebhookDelivery` | the feature's `database` (default: the default database) | One delivery of an event to a subscription, created in the transaction of the write that caused it, with the outcome of its last attempt. |

## Tags

### `@webhooks`

`@webhooks` makes the entity's write events deliverable to subscriptions, `@webhooks created,updated` only those operations, and `@webhooks off` none of them.

**Applies to:** entities

**Syntax:** `@webhooks <events>` or `@webhooks off`

**Options:** `webhooks.entity.events`

```ts
/** @webhooks created,updated */
export type Order = { status: string; total: number };
```

## Commands

### `webhooks list`

Prints each webhook subscription with its id, URL host, whether it is enabled, its tenant, failingSince and its deliveries per status over the last 24 hours.

```bash
quickservicets webhooks list
```

### `webhooks deliveries`

Prints the deliveries of a subscription, newest first, with their type, status, attempt and last outcome.

```bash
quickservicets webhooks deliveries <subscription> [--status <status>] [--limit <n>]
```

**Arguments:**

- `<subscription>` (required): The subscription's id.

**Flags:**

- `--status` (`string`): Only deliveries with this status: pending, delivering, succeeded or failed.
- `--limit` (`integer`, default `20`): How many deliveries to print.

### `webhooks resend`

Sends a finished delivery again, or every failed delivery of a subscription, and prints how many were rescheduled.

```bash
quickservicets webhooks resend <delivery> | --subscription <id> --failed
```

**Arguments:**

- `<delivery>`: The delivery's id.

**Flags:**

- `--subscription` (`string`): Resends deliveries of this subscription, with --failed.
- `--failed` (`boolean`, default `false`): With --subscription, resends every failed delivery.

## Feature API

Other features reach it with `ctx.feature("webhooks")` in their setup, listing `webhooks` in `requires` or `after`.

### `subscriptions`

```ts
subscriptions: WebhookSubscriptions;
```

Creates, lists, reads, changes, deletes and rotates the secret of subscriptions.

### `resend`

```ts
resend(deliveryId: string): Promise<{ id: string; status: "pending" }>;
```

Sends a finished (`succeeded` or `failed`) delivery again at once, from attempt 0 and with the same `webhook-id`;
throws 409 `Delivery is already scheduled` for a pending or delivering one and 409 `Subscription is disabled`.

### `deliveries`

```ts
deliveries(subscriptionId: string, options?: DeliveryListOptions): Promise<DeliveryPage>;
```

The deliveries of a subscription, newest first, as the delivery log route lists them.

### `delivery`

```ts
delivery(subscriptionId: string, deliveryId: string): Promise<WebhookDelivery>;
```

One delivery of a subscription, with its body and the response kept; throws `Webhook delivery <id> not found`.
