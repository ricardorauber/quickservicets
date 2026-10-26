# events

> Write events for every entity, delivered to listeners inside the write's transaction or after its commit.

Write events for every entity, delivered to listeners inside the write's transaction or after its commit.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
events: {}
```

It is not enabled by default: turn it on with `events: {}` or `QS_EVENTS_ENABLED=true`, and off with `events: false` or `QS_EVENTS_ENABLED=false`.

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `events.outbox.enabled` | `boolean` | `true` | `QS_EVENTS_OUTBOX_ENABLED` | no | Stores the chosen events in the write's transaction, so any worker or replica reads every committed event. Turns it off when false. |
| `events.outbox.events` | `string[]` | `["*"]` | `QS_EVENTS_OUTBOX_EVENTS` | no | The event patterns stored in the outbox. |
| `events.outbox.retention` | `duration` | `"7d"` | `QS_EVENTS_OUTBOX_RETENTION` | no | How long outbox rows are kept; rows with undelivered deliveries stay. |
| `events.outbox.dispatch` | `boolean` | `true` | `QS_EVENTS_OUTBOX_DISPATCH` | no | Runs the delivery dispatcher in this worker. |
| `events.outbox.delivery.pollInterval` | `duration` | `"1s"` | `QS_EVENTS_OUTBOX_DELIVERY_POLL_INTERVAL` | no | How often the dispatcher looks for due deliveries. |
| `events.outbox.delivery.batch` | `integer` | `100` | `QS_EVENTS_OUTBOX_DELIVERY_BATCH` | no | Deliveries claimed per poll. |
| `events.outbox.delivery.timeout` | `duration` | `"30s"` | `QS_EVENTS_OUTBOX_DELIVERY_TIMEOUT` | no | How long a delivery may run before it is aborted and retried; the lease of a claimed row. |
| `events.outbox.delivery.retries` | `integer` | `10` | `QS_EVENTS_OUTBOX_DELIVERY_RETRIES` | no | Failed attempts before a delivery becomes failed. |
| `events.outbox.delivery.retryDelay` | `duration` | `"10s"` | `QS_EVENTS_OUTBOX_DELIVERY_RETRY_DELAY` | no | The first retry delay, doubled each attempt. |
| `events.outbox.delivery.maxRetryDelay` | `duration` | `"1h"` | `QS_EVENTS_OUTBOX_DELIVERY_MAX_RETRY_DELAY` | no | The longest retry delay. |
| `events.beforeEmit` | `hook` | — | not overridable | no | Runs before an event reaches any listener or the outbox; returns a changed event or null to drop it, and a throw fails the write. |
| `events.afterEmit` | `hook` | — | not overridable | no | Runs after an event was stored and handed to after-commit dispatch. |
| `events.bus` | `EventBus` | — | not overridable | no | Replaces the in-process after-commit dispatch; in-transaction listeners and the outbox stay. |
| `events.enabled` | `boolean` | `true` | `QS_EVENTS_ENABLED` | no | Turns the feature off when false. |

## Tags

### `@events`

`@events off` stops every event of the entity, so its writes keep their plain statements; `@events outbox=false` keeps its events out of the outbox.

**Applies to:** entities

**Syntax:** `@events [outbox=…]` or `@events off`

**Options:** `events.outbox`

```ts
/** @events off */
export type Session = { token: string };
```

## Commands

### `events outbox`

Prints, per durable consumer, how many deliveries are pending, delivering, delivered and failed, and the age of the oldest pending one.

```bash
quickservicets events outbox
```

### `events retry`

Resets failed deliveries to pending with attempt 0, one by id or every failed one of a consumer, and prints how many.

```bash
quickservicets events retry <delivery id> | quickservicets events retry --consumer <name> --failed
```

**Arguments:**

- `<id>`: The id of one failed delivery.

**Flags:**

- `--consumer` (`string`): The consumer whose failed deliveries are reset.
- `--failed` (`boolean`, default `false`): Resets the consumer's failed deliveries.

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `events.beforeEmit` | before | Runs before an event reaches any listener or the outbox; returns a changed event or null to drop it, and a throw fails the write. |
| `events.afterEmit` | after | Runs after an event was stored and handed to after-commit dispatch. |

## Feature API

Other features reach it with `ctx.feature("events")` in their setup, listing `events` in `requires` or `after`.

### `addHook`

```ts
addHook(name: "beforeEmit", fn: FeatureHook<AnyEvent | null, { operation: OperationInfo | undefined }>): void;
```

Appends a `beforeEmit` hook after the config's; it may change an event or return null to drop it.

### `addHook`

```ts
addHook(name: "afterEmit", fn: FeatureHook<AnyEvent, undefined>): void;
```

Appends an `afterEmit` hook after the config's; it observes each event once stored and handed to dispatch.

### `on`

```ts
on: Events["on"];
```

Registers a listener for a pattern; see `events.on`.

### `emit`

```ts
emit: Events["emit"];
```

Publishes a custom event; see `events.emit`.

### `deliver`

```ts
deliver: Events["deliver"];
```

Registers a durable consumer of the outbox; see `events.deliver`.
