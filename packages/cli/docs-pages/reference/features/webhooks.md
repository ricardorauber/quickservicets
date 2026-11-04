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
| `webhooks.entity.fields` | `string[]` | — | `QS_WEBHOOKS_ENTITY_FIELDS` | no | The only fields, with id, a delivered record of a tagged entity carries; all but hidden and sensitive fields without it. |
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
| `webhooks.delivery.headers.<name>` | `record of string` | — | `QS_WEBHOOKS_DELIVERY_HEADERS_<NAME>` | no | A header value. |
| `webhooks.incoming.tolerance` | `duration` | `"5m"` | `QS_WEBHOOKS_INCOMING_TOLERANCE` | no | How far a signed timestamp of an incoming webhook may be from now. |
| `webhooks.incoming.maxBodySize` | `size` | `"1MB"` | `QS_WEBHOOKS_INCOMING_MAX_BODY_SIZE` | no | The largest body an incoming webhook route reads. |
| `webhooks.incoming.dedupe.enabled` | `boolean` | `true` | `QS_WEBHOOKS_INCOMING_DEDUPE_ENABLED` | no | Processes each incoming delivery id once, keeping a receipt per delivery. Turns it off when false. |
| `webhooks.incoming.dedupe.retention` | `duration` | `"7d"` | `QS_WEBHOOKS_INCOMING_DEDUPE_RETENTION` | no | How long receipts of processed deliveries are kept. |
| `webhooks.incoming.async` | `boolean` | `false` | `QS_WEBHOOKS_INCOMING_ASYNC` | no | Runs the handle of every webhook route in the webhooks/incoming queue; defineWebhook's async and a route's @webhook async= win. |
| `webhooks.beforeDeliver` | `hook` | — | not overridable | no | Runs before each attempt with the subscription, the delivery, the body and the headers; it may return a changed body or headers, and a throw ends the delivery failed without retries. |
| `webhooks.afterDeliver` | `hook` | — | not overridable | no | Runs after each attempt with the subscription, the delivery, the status, whether it succeeded and the duration. |
| `webhooks.onDisabled` | `hook` | — | not overridable | no | Runs after a subscription is disabled, with it and the reason. |
| `webhooks.beforeHandle` | `hook` | — | not overridable | no | Runs before the handle of an incoming webhook with the event and its context; it may return a changed event, and an HttpError is answered. |
| `webhooks.afterHandle` | `hook` | — | not overridable | no | Runs after the handle of an incoming webhook with the event, its context, the duration and the error, when it threw. |
| `webhooks.sender` | `WebhookSender` | — | not overridable | no | Replaces signing and sending: `send({ subscription, delivery, body, headers, signal })` resolves `{ status, body?, durationMs }`; scheduling, retries, disabling, the log and events stay. |
| `webhooks.enabled` | `boolean` | `true` | `QS_WEBHOOKS_ENABLED` | no | Turns the feature off when false. |
| `webhooks.database` | `string` | — | `QS_WEBHOOKS_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |

## Entities

With named databases ([`databases`](/reference/config/)), each entity of the feature lives in one place; `webhooks.database` (`QS_WEBHOOKS_DATABASE`) moves the entities that live in the feature's database.

| Entity | Database | Description |
| --- | --- | --- |
| `WebhookSubscription` | the feature's `database` (default: the default database) | The subscriptions: a URL, the event patterns, the secret and the tenant. |
| `WebhookDelivery` | the feature's `database` (default: the default database) | One delivery of an event to a subscription, created in the transaction of the write that caused it, with the outcome of its last attempt. |
| `WebhookReceipt` | the feature's `database` (default: the default database) | One received incoming delivery per route, id and tenant, while incoming.dedupe is on and the project has a webhook.ts file. |

## Tags

### `@webhooks`

`@webhooks` makes the entity's write events deliverable to subscriptions, `@webhooks created,updated` only those operations, `@webhooks fields=status,total` limits delivered records to those fields and `id`, and `@webhooks off` keeps the entity's events out even when `events` matches them.

**Applies to:** entities

**Syntax:** `@webhooks <events> [fields=…]` or `@webhooks off`

**Options:** `webhooks.entity.events`, `webhooks.entity.fields`

**Forms:** `@webhooks events=created,updated,deleted` or `@webhooks.events created,updated,deleted` set the same option; a dotted line sets one option, and several merge with one plain `@webhooks` line.

```ts
/** @webhooks created,updated fields=status,total */
export type Order = { status: string; total: number; notes: string };
```

### `@webhook`

`@webhook` on a `webhook.ts` file sets that route's `tolerance`, `maxBodySize`, `dedupe` and `async`, like `@webhook dedupe=false tolerance=10m`.

**Applies to:** endpoints

**Syntax:** `@webhook [tolerance=…] [maxBodySize=…] [dedupe=…] [async=…]` or `@webhook off`

**Options:** `webhooks.incoming.tolerance`, `webhooks.incoming.maxBodySize`, `webhooks.incoming.dedupe`, `webhooks.incoming.async`

**Forms:** `@webhook tolerance=5m` or `@webhook.tolerance 5m` set the same option; a dotted line sets one option, and several merge with one plain `@webhook` line.

```ts
/** @webhook dedupe=false tolerance=10m */
export default defineWebhook({ verify, handle });
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

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `webhooks.beforeDeliver` | before | Runs before each attempt with the subscription, the delivery, the body and the headers; it may return a changed body or headers, and a throw ends the delivery failed without retries. |
| `webhooks.afterDeliver` | after | Runs after each attempt with the subscription, the delivery, the status, whether it succeeded and the duration. |
| `webhooks.onDisabled` | on | Runs after a subscription is disabled, with it and the reason. |
| `webhooks.beforeHandle` | before | Runs before the handle of an incoming webhook with the event and its context; it may return a changed event, and an HttpError is answered. |
| `webhooks.afterHandle` | after | Runs after the handle of an incoming webhook with the event, its context, the duration and the error, when it threw. |

## Feature API

Other features reach it with `ctx.feature("webhooks")` in their setup, listing `webhooks` in `requires` or `after`.

### `addHook`

```ts
addHook<K extends keyof WebhookHooks>(name: K, fn: WebhookHooks[K]): void;
```

Appends a hook after the config's: `beforeDeliver`, `afterDeliver`, `onDisabled`, `beforeHandle` or `afterHandle`.

### `verifier`

```ts
verifier(name: string, verifier: WebhookVerifier): void;
```

Registers a verifier `webhook.ts` files name with `verify: "<name>"`, during setup only.

## Routes

With the `auth` native and `routes` on, under `routes.path` (default `/webhooks`), for users holding one of `routes.roles` and scoped to the request's tenant:

- `GET /webhooks`, `POST /webhooks` (201 with the `secret`), `GET`, `PATCH` and `DELETE /webhooks/[id]`, `POST /webhooks/[id]/rotate-secret` and `POST /webhooks/[id]/ping` (10 per minute);
- `GET /webhooks/[id]/deliveries`, `GET /webhooks/[id]/deliveries/[deliveryId]` and `POST /webhooks/[id]/deliveries/[deliveryId]/resend` (202; 30 per minute).

A project endpoint file at one of these paths, like `endpoints/webhooks/get.ts`, replaces that route. Incoming webhooks are `webhook.ts` endpoint files that default-export `defineWebhook({ verify, handle, async? })`, served as `POST`.

## Hooks

`beforeDeliver` (`{ subscription, delivery, body, headers }`, may return a changed body or headers; a throw ends the delivery `failed` with `Canceled by beforeDeliver: <message>` without retries), `afterDeliver` (`{ subscription, delivery, status, ok, durationMs }`), `onDisabled` (`{ subscription, reason }`), `beforeHandle` (`{ event, ctx }` of an incoming webhook, may return a changed event; an `HttpError` is answered) and `afterHandle` (`{ event, ctx, durationMs, error? }`). Features add them with `ctx.feature("webhooks").addHook(name, fn)`, and register verifiers that `webhook.ts` files name as `verify: "<name>"` with `ctx.feature("webhooks").verifier(name, verifier)`.

## The WebhookSender contract

`sender` replaces signing and sending: `send({ subscription, delivery, body, headers, signal })` gets each attempt's exact body text and headers (without `webhook-signature`) and resolves `{ status, body?, durationMs }`, or rejects to fail the attempt with the error's message. The native keeps scheduling, retries, disabling, the delivery log and the events.
