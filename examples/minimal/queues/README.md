# queues

The smallest project that shows the `queues` native: a `User` entity, the consumer file `queues/send-email.ts`, and an endpoint `POST /users/[id]/welcome` that adds a message to it with `req.queue.add`. Messages are stored in the project's database, in the `queue_messages` table.

```bash
bun run test
```

## Level 0: enable

Turn the native on and add a consumer file to `queues/`; its path names the queue (`send-email`):

```ts
export default defineConfig({ database: memoryAdapter(), queues: {} });
```

```ts
// queues/send-email.ts
export default queue<{ userId: string }>(async ({ payload, repos }) => {
  const user = await repos.users.findById(payload.userId);
  return { sentTo: user?.email };
});
```

Endpoints and hooks add messages with `req.queue.add`, jobs with `ctx.queue.add`, and any other code with `queues.add`:

```ts
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", { userId: req.params.id! });
```

## Level 1: options and environment

Every option has a default and a `QS_*` variable; a queue file's options win over them. Every process runs the consumers, one message per queue at a time by default; `consume: false` keeps a process from consuming while it still adds messages:

```ts
queues: { concurrency: 4, retries: 5, retryDelay: "30s" }
```

```bash
QS_QUEUES_CONSUME=false bun .generated/server.ts
```

## Level 2: tags

`@publish` sends an entity's write events to a queue in the write's transaction (`events` queue by default); it needs `events: {}`:

```ts
/** @publish created,updated queue=events */
export type User = { email: string };
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
  onDead: ({ message, error }) => console.error(message.queue, message.id, error),
}
```

```ts
events.on("queue.message.dead", (event) => console.error(event.payload.queue, event.payload.messageId));
```

## Level 5: override files

A queue a feature ships in `features/<key>/queues/<name>.ts` is named `<key>/<name>`; a project file `queues/<key>/<name>.ts` replaces it, with an `Override:` line in the build output:

```ts
// queues/billing/close.ts replaces features/billing/queues/close.ts
export default queue(async ({ payload }) => closeInvoice(payload));
```

## Level 6: replace the implementation

Messages live in the project's database through `databaseBroker()`; any object with the `QueueBroker` methods replaces it, and `runQueueBrokerContract` from `@quickservice/core/testing` checks it:

```ts
queues: { broker: rabbitBroker({ url: env.RABBIT_URL }) }
```

## Level 7: eject

Copy the native into the project as a `features/queues/` project feature that replaces it:

```bash
quickservice eject queues
```
