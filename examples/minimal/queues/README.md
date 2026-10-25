# queues

The smallest project that shows the `queues` native: users tagged `@publish created`, an `Outbox` entity recording sent emails, the consumers `queues/send-email.ts` (which fails for addresses at `fail.test`) and `queues/events.ts`, an endpoint `POST /users/[id]/welcome` that adds a message with a dedupe key, a `digest` project feature shipping a queue the project replaces, and a small in-memory broker.

```bash
bun run test
```

The queues guide (`docs/src/content/docs/guides/queues.md`, on the site at `/guides/queues/`) explains every piece.

## Level 0: enable

Turn the native on and add a consumer file to `queues/`; its path names the queue (`send-email`), and `req.queue.add` adds messages to it:

```ts
// quickservice.config.ts
export default defineConfig({ database: memoryAdapter(), queues: {} });

// queues/send-email.ts
export default queue<{ userId: string }>(async ({ payload, repos }) => {
  const user = await repos.users.findById(payload.userId);
  return { sentTo: user?.email };
});
```

## Level 1: options and environment

Every option has a default and a `QS_*` variable; `overrides` sets the options of one queue over its file's, and a per-queue variable wins over both:

```ts
queues: { concurrency: 4, overrides: { "send-email": { concurrency: 2 } } }
```

```bash
QS_QUEUES_OVERRIDES_SEND_EMAIL_CONCURRENCY=8 bun .generated/server.ts
```

## Level 2: tags

`@publish` sends an entity's write events to a queue in the write's transaction (`events` by default); it needs `events: {}`:

```ts
/** @publish created,updated queue=events */
export type User = { email: string; name: string };
```

## Level 3: per request

`defaultPriority` and `defaultDelay` apply to `req.queue.add` calls that leave them out; a function of the request, its user and tenant computes them per request:

```ts
queues: { defaultPriority: ({ req }) => (req?.headers.get("x-vip") ? 10 : 0) }
```

## Level 4: hooks and events

`beforeEnqueue`, `afterEnqueue`, `beforeProcess`, `afterProcess` and `onDead` run around each step, and with `events: {}` every outcome is an event too:

```ts
queues: {
  beforeEnqueue: (step) => ({ ...step, payload: { ...(step.payload as object), source: "api" } }),
  onDead: ({ message, error }) => console.error("dead", message.queue, message.id, error),
}
```

```ts
events.on("queue.message.dead", (event) => console.error("dead", event.payload.queue, event.payload.messageId));
```

## Level 5: override files

The `digest` feature ships `features/digest/queues/notify.ts`, the queue `digest/notify`; the project's `queues/digest/notify.ts` replaces it, and the build prints an `Override:` line:

```ts
// queues/digest/notify.ts
export default queue<{ userId: string }>(() => ({ sentBy: "project" }));
```

## Level 6: replace the implementation

Messages live in the project's database through `databaseBroker()`; any object with the `QueueBroker` methods replaces it, like the in-memory broker of `memory-broker.ts`, and `runQueueBrokerContract` from `@quickservice/core/testing` checks a broker:

```ts
queues: { broker: memoryBroker() }
```

## Level 7: eject

Copy the native into the project as a `features/queues/` project feature that replaces it:

```bash
quickservice eject queues
```
