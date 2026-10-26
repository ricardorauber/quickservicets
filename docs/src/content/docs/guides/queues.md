---
title: Queues
description: Do work in the background with typed messages stored in your own database, consumed by every worker with retries, backoff, timeouts, dead letters, dedupe, @publish and replaceable brokers.
sidebar:
  order: 49
---

Some work should not happen while a client waits: sending an email, calling a slow partner API, resizing an image, syncing a CRM. The `queues` native lets an endpoint, a hook, a job or any other code add a typed message to a queue and answer at once, while a consumer runs the work in the background, on every worker and replica, with retries, timeouts and a dead letter for messages that keep failing. Messages live in the project's own database (the `queue_messages` table), so a message added inside a transaction exists exactly when the transaction commits, and no other server is needed. The options, variables, hooks, tag and commands are listed on the [queues reference page](/reference/features/queues/).

The samples come from the example project `examples/minimal/queues`: users tagged `@publish created`, an `Outbox` entity recording sent emails, a welcome email consumer that fails for addresses at `fail.test`, a consumer of the published events, a `digest` feature whose queue the project replaces, and a small in-memory broker.

## Declaring consumers

Turn the native on with `queues: {}`, then add one file per queue to `queues/`. Each file default-exports `queue(handler, options?)`, and its path without extension is the queue's name: `queues/send-email.ts` is `send-email`, `queues/billing/close.ts` is `billing/close`. A file without a default `queue(...)` fails the build.

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  events: {},
  queues: {
    overrides: { "send-email": { concurrency: 2 } },
    defaultPriority: ({ req }) => (req?.headers.get("x-vip") ? 10 : 0),
  },
  digest: {},
});
```

The handler receives `ctx` with the `payload`, the typed `repos`, the `message` (`id`, `queue`, `attempt` from 1, `enqueuedAt`, `dedupeKey`), a `signal` aborted on timeout or shutdown, `log`, which writes to the service logger with the queue and message id, and `queue`, to add more messages. Its return value is stored as the message's `result`; a throw fails the attempt.

```ts title="queues/send-email.ts"
import { queue } from "@quickservicets/core";

/** Sends the welcome email of a user and records it; addresses at fail.test bounce. */
export default queue<{ userId: string }>(
  async ({ payload, repos, log }) => {
    const user = await repos.users.findById(payload.userId);
    if (!user) return { skipped: "unknown user" };
    if (user.email.endsWith("@fail.test")) throw new Error(`Mailbox ${user.email} rejected the message`);
    const sent = await repos.outboxes.create({ to: user.email, subject: `Welcome, ${user.name}!`, sentAt: new Date() });
    log.info("welcome email sent", { to: user.email });
    return { outboxId: sent.id };
  },
  { retries: 2, retryDelay: "10s", dedupeWindow: "1d" },
);
```

## Payload types

The type argument of `queue<Payload>` is the payload's type. The build collects every queue into the `QueuePayloads` interface of `.generated/types.ts`, so `add` with an unknown name or a wrong payload is a type error, in endpoints, hooks, jobs and features alike. Payloads are stored as JSON: a payload that is not JSON-serializable, like one with a `BigInt`, fails with `Queue payload for <name> is not JSON-serializable`.

## Adding messages

Endpoints and hooks add messages with `req.queue.add(name, payload, options?)`, jobs and consumers with `ctx.queue.add`, and any other code with `queues.add` from `@quickservicets/core`. Each call resolves `{ id, deduplicated }`; a name no queue declares fails with `Unknown queue <name>`.

```ts title="endpoints/users/[id]/welcome/post.ts"
import type { ServiceRequest } from "@quickservicets/core";

/** Queues the welcome email of a user once: repeated requests return the same message. */
export default async (_repos: unknown, req: ServiceRequest) =>
  req.queue.add("send-email", { userId: req.params.id! }, { dedupeKey: `welcome:${req.params.id}` });
```

The options of `add`:

| Option | What it does |
| --- | --- |
| `delay` | Runs the message once this duration passed, like `"5m"`. |
| `runAt` | Runs it at this time or later, a `Date` or ISO 8601 text; a time in the past runs as soon as possible. Not with `delay`. |
| `priority` | From -100 to 100 (default 0): consumers take higher priorities first, then the earliest `runAt`. |
| `dedupeKey` | 1 to 255 characters: while a message of the queue with this key waits or runs, `add` returns it with `deduplicated: true` instead of adding another. |

```ts
await req.queue.add("send-email", { userId }, { delay: "10m", priority: 5 });
```

Dedupe holds across concurrent requests, workers and replicas: a unique slot on live messages lets exactly one of several simultaneous adds insert, and the others get the existing id. Once a message completed or died its key is free again, unless the queue sets `dedupeWindow`: the welcome queue keeps a completed message's key for a day, so the welcome endpoint sends one email per user however often it is called.

## Transactions

`add` joins the current transaction (`repos.transaction`, or a write's transaction in a hook or an `inTransaction` listener): the message exists only if the transaction commits, so a consumer never sees work for a write that was rolled back, and work is never lost for one that committed.

```ts
await repos.transaction(async () => {
  const order = await repos.orders.create(input);
  await req.queue.add("send-receipt", { orderId: order.id });
});
```

## Processing, concurrency, workers and replicas

Every process that runs the service starts one consumer loop per declared queue. A loop claims due messages with a conditional update and a lease (`lockedUntil`, the queue's `timeout` from now), so two workers or replicas never run the same message at once, and runs at most `concurrency` messages of the queue at a time in that process (default 1). An idle loop looks again every `pollInterval` (default `1s`); an `add` in the same process wakes the queue's loop at once.

While a message runs its lease is renewed; a process that crashed leaves its messages `active` with a lease that passes, and every process returns those to `waiting` at startup and once a minute, so they run again. On shutdown the consumers stop claiming, abort the running handlers' `signal`, wait up to `jobs.shutdownGrace`, and give back the messages still running without counting their attempt. `consume: false` (or `QS_QUEUES_CONSUME=false`) keeps a process from consuming while it still adds messages, for replicas that only serve traffic.

## Retries and backoff

A failed attempt goes back to `waiting` after `retryDelay × 2^(attempt − 1)`, capped by `maxRetryDelay`, with a random jitter of up to 10%; the welcome queue retries twice, after about 10 and then 20 seconds. The defaults are 3 retries, `10s` and `1h`; a queue file's options win over them, and `maxAttempts` (retries + 1) is stored when the message is added.

## Timeouts

A run longer than the queue's `timeout` (default `5m`) fails at once with `Timed out after <timeout>`, and its `ctx.signal` is aborted with a `TimeoutError`; pass the signal to `fetch` and other calls so they stop too. A later result of the handler changes nothing.

## Dead letter and the CLI

A message that failed its last attempt is `dead`: it keeps its payload, attempts and `lastError`, is never claimed again, and logs `queue.message.dead`. Fix the cause, then requeue it with `queues.retry(id)` or every dead message of a queue with `queues.retryDead(queue)`; it runs again from attempt 1.

```bash
quickservicets queue list
quickservicets queue dead send-email --limit 5
quickservicets queue retry --queue send-email --dead
```

```text
send-email: waiting 0, active 0, completed 12, dead 1; oldest waiting 0s
01a1…7c2e  attempts 3  2026-10-25T11:02:31.004Z  Mailbox bob@fail.test rejected the message
Requeued 1 message
```

## Retention

Every process with consumers deletes `completed` messages finished more than `retention.completed` ago (default 7 days) and `dead` ones after `retention.dead` (default 30 days), at startup and every hour, in batches, safely on several instances at once.

## Publishing entity events with `@publish`

`@publish` on an entity sends its write events to a queue, added by an `inTransaction` listener in the write's transaction, so the message exists exactly when the write commits; cascades are published too. It needs `events: {}`. The options are `events` (the operations, default all three, also the bare first value), `queue` (default `publish.queue`, `events`) and `fields` (the only fields of `before` and `after`, with `id`); without `fields`, `@hidden` and `@sensitive` fields are left out. The event id is the message's dedupe key, so a replayed event is not queued twice.

```ts title="entities/User.ts"
/** @publish created */
export type User = {
  email: string;
  name: string;
};
```

The target queue's payload type is the write events of the entities publishing to it:

```ts title="queues/events.ts"
import { queue, type QueuePayloads } from "@quickservicets/core";

/** Logs each write event that `@publish` sends to the `events` queue. */
export default queue<QueuePayloads["events"]>(({ payload, log }) => {
  log.info("user event", { type: payload.type, recordId: payload.recordId });
  return { type: payload.type };
});
```

The build fails for a `fields` entry that is not a field of the entity, and warns when the target queue has no consumer file.

## Overrides and variables

The options of a queue come, from highest to lowest, from `QS_QUEUES_OVERRIDES_<NAME>_<OPTION>` (the name in upper snake case, `/` and `-` as `_`), `queues.overrides.<name>`, the queue file's options, `QS_QUEUES_<OPTION>`, the `queues` config, and the defaults. The example caps the welcome queue at 2 at once; a deployment raises it without editing code:

```bash
QS_QUEUES_OVERRIDES_SEND_EMAIL_CONCURRENCY=8 bun .generated/server.ts
```

An override naming no queue is a config warning. `defaultPriority` and `defaultDelay` apply to `req.queue.add` calls that leave them out, and can be functions of the request, its user and tenant: the example gives requests with `x-vip` priority 10.

## Hooks and events

`beforeEnqueue` (may change the queue, payload or options, or throw to cancel the `add`), `afterEnqueue`, `beforeProcess` (may change the payload, or throw to fail the attempt), `afterProcess` and `onDead` run around each step, from the config or from another feature through `ctx.feature("queues").addHook`. A failing after-hook is only logged as `feature.hook.failed`.

```ts
queues: {
  beforeEnqueue: (step) => ({ ...step, payload: { ...(step.payload as object), source: "api" } }),
  onDead: ({ message, error }) => console.error("dead", message.queue, message.id, error),
}
```

With `events: {}`, every outcome is also the event `queue.message.completed`, `queue.message.failed` or `queue.message.dead`:

```ts
events.on("queue.message.dead", (event) => console.error("dead", event.payload.queue, event.payload.messageId));
```

A queue a feature ships in `features/<key>/queues/<name>.ts` is named `<key>/<name>`; the project's `queues/<key>/<name>.ts` replaces it with an `Override:` line, as `queues/digest/notify.ts` replaces the queue of the example's `digest` feature.

## Brokers and the contract kit

The database is one implementation of the `QueueBroker` interface: `enqueue`, `start`, `stop` and `stats`, and the optional `retry`, `retryDead`, `dead`, `cleanup` and `health`. `queues: { broker }`, or `ctx.feature("queues").setBroker(broker)` from a feature's setup, moves messages to another broker such as RabbitMQ, Kafka, Redis or SQS, while `add`, `@publish` and the consumers stay the same. A broker that cannot join the database transaction publishes after the commit with `afterCommit`. The example's `memory-broker.ts` is the smallest broker:

```ts title="memory-broker.ts"
import { afterCommit, type QueueBroker, type QueueBrokerContext, type QueueBrokerMessage } from "@quickservicets/core";

/** A small broker that keeps messages in memory and runs each once: enough to show how a broker plugs in. */
export function memoryBroker(): QueueBroker & { received: QueueBrokerMessage[] } {
  const received: QueueBrokerMessage[] = [];
  let ctx: QueueBrokerContext | undefined;
  const run = (id: string, message: QueueBrokerMessage) =>
    void ctx?.handle({ id, queue: message.queue, payload: message.payload, attempt: 1, enqueuedAt: new Date() }, { signal: new AbortController().signal });
  return {
    name: "memory",
    received,
    async enqueue(message, { transactional }) {
      const id = crypto.randomUUID();
      const publish = () => {
        received.push(message);
        run(id, message);
      };
      // It cannot join the database transaction, so it publishes once the transaction commits.
      if (transactional) await afterCommit(publish);
      else publish();
      return { id, deduplicated: false };
    },
    start(context) {
      ctx = context;
    },
    async stop() {
      ctx = undefined;
    },
    async stats() {
      return {};
    },
  };
}
```

A real broker keeps retries, delays, priorities and dedupe too: `runQueueBrokerContract(createBroker)` from `@quickservicets/core/testing` registers the tests every broker must pass, and the database broker passes them on memory, SQLite and PostgreSQL. A broker without an optional method makes the matching command and function fail with `The <name> queue broker does not support <method>`.

## Queues or jobs

Use a [job](/guides/jobs/) for work that happens on a schedule or as one named task (a nightly cleanup, a report every Monday), recorded per run. Use a queue for work triggered by something that happened, one message per occurrence (an email per signup, a sync per changed record), with many messages in flight, dedupe, priorities and a dead letter. A job often adds messages to a queue: the job decides what to do, the queue does it item by item.

## See also

- [Queues reference](/reference/features/queues/): every option with its variable, the hooks, `@publish` and the commands.
- [Send an email in the background](/recipes/send-email-in-the-background/): a welcome email from a hook, with dedupe and retries.
- [Events](/guides/events/): write events and listeners, which `@publish` builds on.
- [Jobs](/guides/jobs/): scheduled and on-demand runs.
