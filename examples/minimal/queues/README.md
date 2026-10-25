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

Every option has a default and a `QS_*` variable; a queue file's options win over them:

```ts
queues: { retries: 5, retryDelay: "30s" }
```

```bash
QS_QUEUES_RETRIES=5 bun .generated/server.ts
```

## Level 2: tags

Not applicable: queues have no entity, field or endpoint of their own, so the native adds no tag yet.

## Level 3: per request

Not applicable: no queue option is resolved per request yet; each message carries the id of the request that added it.

## Level 4: hooks and events

Not applicable: the native declares no hook yet.

## Level 5: override files

Not applicable: this example has no feature that ships a queue yet.

## Level 6: replace the implementation

Not applicable: the database is the only place messages are stored so far.

## Level 7: eject

Copy the native into the project as a `features/queues/` project feature that replaces it:

```bash
quickservice eject queues
```
