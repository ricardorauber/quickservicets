# queues

> Background queues stored in the project's database, with consumers declared as files in queues/.

Background queues stored in the project's database, with consumers declared as files in queues/.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
queues: {}
```

It is not enabled by default: turn it on with `queues: {}` or `QS_QUEUES_ENABLED=true`, and off with `queues: false` or `QS_QUEUES_ENABLED=false`.

**Runs after:** `events`

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `queues.consume` | `boolean` | `true` | `QS_QUEUES_CONSUME` | no | Runs the consumers in this process; false keeps add working in processes that only enqueue. |
| `queues.concurrency` | `integer` | `1` | `QS_QUEUES_CONCURRENCY` | no | How many messages of each queue run at once in one process. |
| `queues.pollInterval` | `duration` | `"1s"` | `QS_QUEUES_POLL_INTERVAL` | no | How long an idle consumer waits before it looks for messages again. |
| `queues.timeout` | `duration` | `"5m"` | `QS_QUEUES_TIMEOUT` | no | The longest a message may run; the lease of a claimed message. |
| `queues.retries` | `integer` | `3` | `QS_QUEUES_RETRIES` | no | How many times a failed message is retried before it is dead. |
| `queues.retryDelay` | `duration` | `"10s"` | `QS_QUEUES_RETRY_DELAY` | no | The delay before the first retry, doubled for each next one. |
| `queues.maxRetryDelay` | `duration` | `"1h"` | `QS_QUEUES_MAX_RETRY_DELAY` | no | The longest delay between two attempts. |
| `queues.retention.completed` | `duration` | `"7d"` | `QS_QUEUES_RETENTION_COMPLETED` | no | How long completed messages are kept after they finish. |
| `queues.retention.dead` | `duration` | `"30d"` | `QS_QUEUES_RETENTION_DEAD` | no | How long dead messages are kept after they finish. |
| `queues.overrides.<name>.concurrency` | `record of integer` | — | `QS_QUEUES_OVERRIDES_<NAME>_CONCURRENCY` | no | How many messages of the queue run at once in one process. |
| `queues.overrides.<name>.timeout` | `record of duration` | — | `QS_QUEUES_OVERRIDES_<NAME>_TIMEOUT` | no | The longest a message of the queue may run. |
| `queues.overrides.<name>.retries` | `record of integer` | — | `QS_QUEUES_OVERRIDES_<NAME>_RETRIES` | no | How many times a failed message of the queue is retried. |
| `queues.overrides.<name>.retryDelay` | `record of duration` | — | `QS_QUEUES_OVERRIDES_<NAME>_RETRY_DELAY` | no | The first retry delay of the queue. |
| `queues.overrides.<name>.dedupeWindow` | `record of duration` | — | `QS_QUEUES_OVERRIDES_<NAME>_DEDUPE_WINDOW` | no | How long a completed message of the queue keeps deduplicating its key. |
| `queues.defaultPriority` | `integer` | `0` | `QS_QUEUES_DEFAULT_PRIORITY` | yes | The priority of req.queue.add calls that give none; a function of the request, its user and tenant sets it per request. |
| `queues.defaultDelay` | `duration` | — | `QS_QUEUES_DEFAULT_DELAY` | yes | The delay of req.queue.add calls that give neither delay nor runAt; a function of the request sets it per request. |
| `queues.beforeEnqueue` | `hook` | — | not overridable | no | Runs before a message is added with the queue, payload and options; returns them changed, and a throw cancels the add. |
| `queues.afterEnqueue` | `hook` | — | not overridable | no | Runs after a message was added, with its queue, id and whether it was deduplicated. |
| `queues.beforeProcess` | `hook` | — | not overridable | no | Runs before a consumer with the message and payload; returns a changed payload, and a throw fails the attempt. |
| `queues.afterProcess` | `hook` | — | not overridable | no | Runs after each run with the message, its status, result or error and duration. |
| `queues.onDead` | `hook` | — | not overridable | no | Runs when a message used its last attempt, with the message and the error. |
| `queues.broker` | `QueueBroker` | — | not overridable | no | Replaces the database broker, so messages live in another broker such as RabbitMQ, Kafka, Redis or SQS. |
| `queues.publish.queue` | `string` | `"events"` | `QS_QUEUES_PUBLISH_QUEUE` | no | The queue an entity tagged @publish sends its write events to. |
| `queues.publish.events` | `("created" \| "updated" \| "deleted")[]` | `["created","updated","deleted"]` | `QS_QUEUES_PUBLISH_EVENTS` | no | The write operations a tagged entity publishes: created, updated and deleted. |
| `queues.publish.fields` | `string[]` | — | `QS_QUEUES_PUBLISH_FIELDS` | no | The only fields, with id, kept in a published event's before and after; all but hidden and sensitive fields without it. |
| `queues.enabled` | `boolean` | `true` | `QS_QUEUES_ENABLED` | no | Turns the feature off when false. |

## Tags

### `@publish`

`@publish` sends the entity's write events to a queue (`publish.queue`, default `events`) in the write's transaction; `events` limits the operations, `fields` the fields of `before` and `after`.

**Applies to:** entities

**Syntax:** `@publish <events> [queue=…] [fields=…]` or `@publish off`

**Options:** `queues.publish.events`, `queues.publish.queue`, `queues.publish.fields`

```ts
/** @publish created,updated queue=crm-sync */
export type User = { email: string };
```

## Commands

### `queue list`

Prints each queue with its number of waiting, active, completed and dead messages, and the age of its oldest waiting message.

```bash
quickservicets queue list
```

### `queue dead`

Prints the latest dead messages of a queue with their id, attempts, finish time and error message.

```bash
quickservicets queue dead <queue> [--limit <n>]
```

**Arguments:**

- `<queue>` (required): The queue name.

**Flags:**

- `--limit` (`integer`, default `20`): How many messages to print.

### `queue retry`

Moves dead messages back to waiting with attempt 0, one by id or every dead one of a queue, and prints how many.

```bash
quickservicets queue retry <message id> | quickservicets queue retry --queue <name> --dead
```

**Arguments:**

- `<id>`: The id of one dead message.

**Flags:**

- `--queue` (`string`): The queue whose dead messages are requeued.
- `--dead` (`boolean`, default `false`): Requeues the queue's dead messages.

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `queues.beforeEnqueue` | before | Runs before a message is added with the queue, payload and options; returns them changed, and a throw cancels the add. |
| `queues.afterEnqueue` | after | Runs after a message was added, with its queue, id and whether it was deduplicated. |
| `queues.beforeProcess` | before | Runs before a consumer with the message and payload; returns a changed payload, and a throw fails the attempt. |
| `queues.afterProcess` | after | Runs after each run with the message, its status, result or error and duration. |
| `queues.onDead` | on | Runs when a message used its last attempt, with the message and the error. |

## Feature API

Other features reach it with `ctx.feature("queues")` in their setup, listing `queues` in `requires` or `after`.

### `setBroker`

```ts
setBroker(broker: QueueBroker): void;
```

Replaces the database broker with `broker`, from the calling feature's setup only; startup fails with
`Queue broker set by <a> and <b>; keep one` when `queues.broker` or another feature set one too.

### `health`

```ts
health(): Promise<Record<string, unknown>>;
```

Checks the broker for the readiness check: resolves with its fields (the database broker's `waiting` and
`oldestWaitingMs`), or `{}` for a broker without `health`, and throws when it cannot take messages.

### `addHook`

```ts
addHook(name: "beforeEnqueue", fn: FeatureHook<QueueEnqueueStep, QueueEnqueueContext>): void;
```

Appends a `beforeEnqueue` hook after the config's; it may change the call or throw to cancel the `add`.

### `addHook`

```ts
addHook(name: "afterEnqueue", fn: FeatureHook<QueueEnqueued, undefined>): void;
```

Appends an `afterEnqueue` hook after the config's.

### `addHook`

```ts
addHook(name: "beforeProcess", fn: FeatureHook<QueueProcessStep, undefined>): void;
```

Appends a `beforeProcess` hook after the config's; it may change the payload or throw to fail the attempt.

### `addHook`

```ts
addHook(name: "afterProcess", fn: FeatureHook<QueueProcessed, undefined>): void;
```

Appends an `afterProcess` hook after the config's.

### `addHook`

```ts
addHook(name: "onDead", fn: FeatureHook<QueueDeadMessage, undefined>): void;
```

Appends an `onDead` hook after the config's.
