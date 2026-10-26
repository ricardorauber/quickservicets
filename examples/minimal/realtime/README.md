# realtime

The smallest project that shows the `realtime` native: an `endpoints/clock/sse.ts` file that streams the server's time as Server-Sent Events, and a `Task` entity tagged `@changes` whose changes clients follow live at `GET /tasks/changes`, filtered like the list route and resumed with `Last-Event-ID`.

```bash
bun run test
```

The Server-Sent Events guide (`docs/src/content/docs/guides/server-sent-events.md`, on the site at `/guides/server-sent-events/`) explains every piece.

## Level 0: enable

Turn the native on; `sse.ts` endpoints stream, and change streams need `events`:

```ts
export default defineConfig({ database: memoryAdapter(), events: {}, realtime: {} });
```

## Level 1: options and environment

`sse.heartbeat`, `sse.maxStreams`, `sse.changes`, `sse.pollInterval` and `sse.buffer` tune the streams, and every option has a `QS_*` variable:

```ts
realtime: { sse: { heartbeat: "15s", maxStreams: 1000 } }
```

```bash
QS_REALTIME_SSE_HEARTBEAT=30s bun .generated/server.ts
```

## Level 2: tags

`@changes` gives an entity a change stream, `@changes events=created` limits the events it offers, and `@changes off` removes it when `sse.changes` is `all`:

```ts
/** @changes events=created */
export type Task = { title: string; status: "open" | "done"; owner?: string };
```

## Level 3: per request

`sse.beforeDeliver` runs for each change and stream with the request, its user and tenant; returning `false` skips the change for that stream, so each user sees only their own tasks:

```ts
realtime: { sse: { beforeDeliver: ({ user, event }) => (event.after as { owner?: string } | null)?.owner === user?.id } }
```

## Level 4: hooks and events

`sse.beforeSend` changes the data of each message, or skips it with `null`:

```ts
realtime: { sse: { beforeSend: ({ data }) => ({ ...(data as object), sentAt: new Date().toISOString() }) } }
```

## Level 5: override files

A stream is an `sse.ts` file in `endpoints/`, and a project `endpoints/tasks/changes/sse.ts` replaces the generated change stream:

```ts
// endpoints/tasks/changes/sse.ts
export default defineSse((stream) => stream.send({ message: "Changes are paused for maintenance" }));
```

## Level 6: replace the implementation

`sse.changeSource` replaces the outbox and ring buffer sources, for example with one fed by a message broker:

```ts
realtime: {
  sse: {
    changeSource: {
      subscribe: (entities, onEvent) => broker.on("changes", (event) => entities.includes(event.entity) && onEvent(event)),
      replay: async (entities, afterId, limit) => (await broker.since(afterId, limit)) ?? "expired",
    },
  },
}
```

## Level 7: eject

Copy the native into the project as a `features/realtime/` project feature that replaces it:

```bash
quickservice eject realtime
```
