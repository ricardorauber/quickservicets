# events

The smallest project that shows the `events` native: posts and comments (comments go away with their post), a listener file that keeps each post's `commentCount`, an endpoint that publishes a post and emits `post.published` in one transaction, and a `notify` feature that ships a listener file and, with the outbox on, a durable consumer.

```bash
bun run test
```

The events guide (`docs/src/content/docs/guides/events.md`, on the site at `/guides/events/`) explains every piece.

## Level 0: enable

Turn the native on, then add a listener file to `events/`; it runs after each committed change of a comment:

```ts
export default defineConfig({ database: memoryAdapter(), events: {}, notify: {} });
```

```ts
// events/count-comments.ts
export default listen("comment.written", async (event, { repos }) => {
  const postId = (event.after ?? event.before).post;
  if (!(await repos.posts.findById(postId))) return;
  const commentCount = await repos.comments.where((comment) => comment.post.eq(postId)).count();
  await repos.posts.update(postId, { commentCount });
});
```

## Level 1: options and environment

`outbox: true` stores every event in the write's transaction, kept 7 days, and every option has a `QS_*` variable:

```ts
events: { outbox: true }
```

```bash
QS_EVENTS_OUTBOX_ENABLED=true QS_EVENTS_OUTBOX_RETENTION=1d bun .generated/server.ts
```

## Level 2: tags

`@events off` stops every event of an entity (here `Notification`), so its writes keep their plain statements; `@events outbox=false` keeps an entity's events in process but out of the outbox:

```ts
/** @events off */
export type Notification = { channel: string; postId: string };
```

```ts
/** @events outbox=false */
export type Draft = { title: string };
```

## Level 3: per request

Not applicable: which events exist does not depend on the request; a `beforeEmit` hook reads the request, its user and tenant through `currentOperation()`, and each event carries `actor` and `requestId`.

## Level 4: hooks and events

An `inTransaction` listener runs inside the write's transaction, and a throw rolls the write back:

```ts
events.on("comment.created", (event) => {
  if (event.after.body.trim() === "") throw new HttpError(400, "A comment needs a body");
}, { phase: "inTransaction" });
```

A `beforeEmit` hook may change an event or drop it before any listener or the outbox sees it:

```ts
events: {
  beforeEmit: (event) => (event?.type === "post.updated" && event.changed.join() === "commentCount" ? null : undefined),
}
```

## Level 5: override files

The `notify` feature ships `features/notify/events/notify.ts`; a project file with the same name replaces it, and the build prints an `Override:` line:

```ts
// events/notify.ts
export default listen("post.published", async (event, { repos }) => {
  await repos.notifications.create({ channel: "project", postId: event.payload.postId });
});
```

## Level 6: replace the implementation

A custom `bus` replaces the in-process after-commit dispatch, while in-transaction listeners and the outbox stay in the native:

```ts
events: { bus: { publish: (event) => broker.send(event), subscribe: (pattern, listener) => broker.on(pattern, listener) } }
```

## Level 7: eject

Copy the native into the project as `features/events/`, which then replaces it with the same behavior:

```bash
bun run quickservice eject events
```
