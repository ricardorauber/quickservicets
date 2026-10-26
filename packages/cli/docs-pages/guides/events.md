# Events

> Run writes in one transaction, react to every created, updated and deleted record and to your own events, store them in a transactional outbox and deliver them at least once to durable consumers.

A service often has to do something because a record changed: keep a counter, notify someone, update a search index or call another service. The `events` native turns every repository write into an event and hands it to listeners, either inside the write's transaction or after it commits, so this code lives next to the data instead of in every endpoint. With the outbox on, the events are also stored in the same transaction as the writes, and durable consumers receive each one at least once, even across restarts and replicas.

The samples come from the example project `examples/minimal/events`: posts, comments that go away with their post, a listener file that keeps each post's `commentCount`, an endpoint that publishes a post, and a `notify` feature.

## Transactions

`repos.transaction(fn)`, or `transaction(fn)` from `@quickservicets/core`, runs several repository calls as one database transaction: every call made inside `fn` (also through hooks or other modules) takes part, a throw rolls everything back and rejects with the error, and the result of `fn` is returned. The publish endpoint of the example updates the post and emits an event in one transaction, so a failed publish leaves neither:

```ts title="endpoints/posts/[id]/publish/post.ts"
import { events, HttpError, type Endpoint } from "@quickservicets/core";

/** Publishes a post and emits `post.published` in the same transaction: a failed publish emits nothing. */
const publish: Endpoint<{ dryRun?: boolean }> = async (repos, req) =>
  repos.transaction(async () => {
    const post = await repos.posts.update(req.params.id!, { published: true });
    await events.emit("post.published", { postId: post.id });
    if ((await req.json()).dryRun) throw new HttpError(409, "Dry run: nothing was published");
    return post;
  });

export default publish;
```

- A `transaction` inside another joins it; there are no savepoints, so the inner writes commit or roll back with the outer ones.
- `afterCommit(fn)` queues `fn` to run after the outermost commit, in order, before `transaction` resolves; a failing callback is logged as `transaction.after-commit.failed` and does not fail the transaction. Outside a transaction it runs `fn` at once.
- `onRollback(fn)` runs `fn` after a rollback, and `inTransaction()` tells whether the code runs inside one.
- Relation sync, cascades and file cleanup use the same transactions, so they join yours.
- The memory adapter, SQLite and PostgreSQL roll back; MongoDB does on a replica set or a sharded cluster. On a standalone MongoDB server the first transaction logs `transactions are not atomic on this database; writes in a failed transaction are kept`.

## Write events

`events: {}` in `quickservicets.config.ts` turns the native on (or `QS_EVENTS_ENABLED=true`). From then on every `create`, `update`, `replace` and `delete` of an entity that is not a system entity becomes a write event:

| Field | Value |
| --- | --- |
| `id` | A UUIDv7, in creation order. |
| `type` | `<entity in lower camel case>.<operation>`: `post.created`, `comment.updated`, `orderItem.deleted`. |
| `entity`, `operation`, `recordId` | The entity name, `created`, `updated` or `deleted`, and the record's id. |
| `before`, `after` | The stored record before and after the write; `before` is null for a create and `after` for a delete. |
| `changed` | The top-level fields whose stored values changed, `updatedAt` left out. |
| `cause` | Why the record changed (below). |
| `actor` | The ids of `req.user` and `req.tenant`, or the job or queue name the write ran for. |
| `requestId`, `at` | The request's id and the time of the event. |

Records a write changes indirectly get their own events, with a `cause` other than `write`: `cascade` for records deleted with it (`@onDelete cascade`), `setNull` and `pull` for references cleared or removed from reference arrays, and `touch` for records whose relation side changed through relation sync. A create or update reports its own record first and then the others in the order they changed; a delete reports the deepest cascades first and its own record last. Deleting a post of the example emits `comment.deleted` with `cause: "cascade"` for each comment, then `post.deleted`.

Each event reads `before` inside the write's transaction, so writes of observed entities always run in one; without the native, writes keep their single statements.

## Listeners

`events.on(pattern, listener, { phase })` registers a listener and returns a function that removes it. Features get the same bus as `ctx.events` in their setup.

- `afterCommit` (the default) listeners get each event after the outermost commit, never for a rolled-back write, without delaying the request. Each listener gets its events one at a time, in commit order. A failing one is logged as `event.listener.failed` with `type` and `eventId`, and keeps receiving later events.
- `inTransaction` listeners run inside the write's transaction, awaited in order; a throw rolls the write back and the request fails with the error's response.

```ts
events.on("comment.created", (event) => {
  if (event.after.body.trim() === "") throw new HttpError(400, "A comment needs a body");
}, { phase: "inTransaction" });
```

`events.idle()` resolves once every after-commit delivery started so far has finished; on shutdown the native waits for them within `lifecycle.stopTimeout` and logs `events.shutdown.pending` with what is left.

### Patterns

| Pattern | Matches |
| --- | --- |
| `post.created` | That type only. |
| `post.*`, `*.created`, `*.*.paid` | `*` matches exactly one segment. |
| `comment.written`, `*.written` | The `created`, `updated` and `deleted` events of that entity, or of every entity. |
| `*` | Every event. |

Patterns are compiled once, and the listeners of each type are found the first time it is seen, so an event no listener wants costs one lookup.

## Custom events

`events.emit(type, payload)` publishes an event of your own on the same bus and resolves with its id. Inside a transaction, `inTransaction` listeners get it at once and after-commit listeners after the commit; a rollback drops it. Types are at least two lowercase segments (`post.published`, `invoice.paid`) and may not end with `created`, `updated`, `deleted` or `written`, which belong to write events.

Declare each custom event's payload in `EventMap`, and `emit` and the listeners are typed; the build adds the write events of every entity to it, so `event.after` is typed with the entity's record:

```ts title="event-map.ts"
/** The custom events of the project, with their payloads. */
declare module "@quickservicets/core" {
  interface EventMap {
    "post.published": { postId: string };
  }
}

export {};
```

## Listener files

A file in `events/` default-exports `listen(pattern, listener, options?)` and is registered without any other code, before the listeners features add in their setup. The listener gets the event and `{ repos, log }`, where `log` adds `listener: <file name>` to each entry:

```ts title="events/count-comments.ts"
import { listen } from "@quickservicets/core";

/** Keeps `commentCount` of a post in step with its comments, after each committed comment change. */
export default listen("comment.written", async (event, { repos }) => {
  const postId = (event.after ?? event.before).post;
  if (!(await repos.posts.findById(postId))) return;
  const commentCount = await repos.comments.where((comment) => comment.post.eq(postId)).count();
  await repos.posts.update(postId, { commentCount });
});
```

A feature ships its own listener files in `features/<key>/events/`, and a project file of the same name replaces it, with an `Override:` line in the build:

```ts title="features/notify/events/notify.ts"
import { listen } from "@quickservicets/core";

/** Writes an in-app notification once a post is published. */
export default listen("post.published", async (event, { repos }) => {
  await repos.notifications.create({ channel: "in-app", postId: event.payload.postId });
});
```

## The outbox

Listeners run in the process that made the write. To let other workers and replicas see every committed event, turn the outbox on:

```ts
events: { outbox: true }
```

Each chosen event is then stored as an `OutboxEvent` row in the same transaction as its write: a rolled-back write stores nothing, and a failing insert fails the write. A custom event emitted outside a transaction gets one of its own. The rows are a read-only system entity (`outbox-events`, no routes), created by `migration add` like any entity.

| Option | Default | |
| --- | --- | --- |
| `outbox.events` | `["*"]` | The patterns stored (`QS_EVENTS_OUTBOX_EVENTS=order.*,invoice.*`). |
| `outbox.retention` | `"7d"` | How long rows are kept; workers that run scheduled work delete older ones at startup and every hour, logging `events.outbox.cleanup`. |

`readOutbox({ after, limit, types })` pages through the committed events in id order. Ids follow creation time, not commit time, so a transaction that started earlier can commit later than the reader's cursor: `tailOutbox({ from, onEvent, pollInterval })` re-reads a five-second window before its cursor on every poll and skips the ids it has seen, which delivers each event once.

## Durable consumers

`ctx.events.deliver(name, { pattern, handler, retries?, retryDelay? })` registers a consumer in a feature's setup. Every stored event that matches gets a `pending` `OutboxDelivery` row in its write's transaction, and the dispatcher of every worker (`outbox.dispatch`, on by default) claims due rows with a lease, calls the handler and records the outcome:

- a handler that resolves marks the row `delivered`;
- one that throws or runs past `outbox.delivery.timeout` (its `signal` is aborted) is retried after `retryDelay × 2^(attempt − 1)`, at most `maxRetryDelay` (`10s` and `1h` by default), and becomes `failed` after `retries` attempts (10);
- each outcome is logged as `events.delivery.delivered`, `events.delivery.retry` or `events.delivery.failed`.

Delivery is **at least once**: a worker that crashes after the handler ran but before it stored the outcome leaves the row leased, and another worker delivers it again once the lease expires. Write handlers to be idempotent, as the `notify` feature does:

```ts title="features/notify/index.ts"
import { defineFeature, type Repositories } from "@quickservicets/core";

/**
 * Notifies about published posts: its listener file `events/notify.ts` writes an in-app notification after the
 * commit, and, with the outbox on, the durable consumer `notify/email` sends an email at least once.
 */
export default defineFeature({
  key: "notify",
  requires: ["events"],
  setup(ctx) {
    let repos: Repositories | undefined;
    ctx.app.onStart((start) => {
      repos = start.repos;
    });
    const outbox = ctx.config.features.find((feature) => feature.key === "events")?.options.outbox as { enabled?: boolean } | undefined;
    if (!outbox?.enabled) return;
    ctx.events.deliver("notify/email", {
      pattern: "post.published",
      // Deliveries repeat after a crash, so the handler skips a post it already notified.
      handler: async (event) => {
        const { postId } = (event as { payload: { postId: string } }).payload;
        if (await repos!.notifications.where((sent) => sent.postId.eq(postId).and(sent.channel.eq("email"))).count()) return;
        await repos!.notifications.create({ channel: "email", postId });
      },
    });
  },
});
```

Events that still have pending, delivering or failed rows survive the retention cleanup; delivered rows go with their event. Two commands inspect and repair deliveries:

```bash
bun run quickservicets events outbox                                 # per consumer: rows per status, oldest pending age
bun run quickservicets events retry <delivery id>                    # reset one failed delivery to pending
bun run quickservicets events retry --consumer notify/email --failed # reset every failed delivery of a consumer
```

## Customization

| Level | How |
| --- | --- |
| Options and environment | Every option has a `QS_*` variable: `QS_EVENTS_OUTBOX_ENABLED`, `QS_EVENTS_OUTBOX_RETENTION`, `QS_EVENTS_OUTBOX_DISPATCH`, `QS_EVENTS_OUTBOX_DELIVERY_RETRIES`, and the others on the reference page. |
| Tags | `@events off` stops every event of an entity, so its writes keep their plain statements (`Notification` in the example); `@events outbox=false` keeps its events in process but out of the outbox. |
| Per request | Which events exist never depends on the request; a hook reads it through `currentOperation()`. |
| Hooks | `beforeEmit(event, { operation })` may return a changed event (its `id`, `type` and `at` stay) or `null` to drop it, and a throw fails the write; `afterEmit(event)` observes each event once it was stored and handed to dispatch. Other features add hooks through `ctx.feature("events").addHook(...)`. |
| Override files | A project `events/<name>.ts` replaces a feature's listener file of the same name. |
| Implementation | `bus: { publish, subscribe }` replaces the in-process after-commit dispatch (`memoryEventBus()` by default), for example with a broker; in-transaction listeners and the outbox stay in the native. |
| Eject | `bun run quickservicets eject events` copies the native into `features/events/`, which then replaces it with the same behavior. |

```ts
events: {
  beforeEmit: (event) => (event?.type === "post.updated" && event.changed.join() === "commentCount" ? null : undefined),
}
```

The feature API, `ctx.feature("events")`, offers `addHook`, `on`, `emit` and `deliver` to features that list `events` in `requires` or `after`.

## See also

- [`events` reference](/reference/features/events/): every option with its variable, the `@events` tag, the hooks, the feature API and the commands.
- [Hooks](/guides/hooks/): code around one route, where events are code around every write.
- [Project features](/guides/project-features/): setup, `requires` and feature APIs.
- [Entity history](/guides/history/): every version of chosen records, written by an in-transaction listener.
- [Server-Sent Events](/guides/server-sent-events/): change streams that send write events to clients live.

Next: [Recipes](/recipes/).
