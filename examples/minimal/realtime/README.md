# realtime

The smallest project that shows the `realtime` native: an `endpoints/clock/sse.ts` file that streams the server's time as Server-Sent Events, a `Task` entity tagged `@changes` whose changes clients follow live at `GET /tasks/changes`, filtered like the list route and resumed with `Last-Event-ID`, and a WebSocket chat room at `endpoints/rooms/[roomId]/ws.ts` for signed-in users, with typed messages, acknowledgments and announcements from `POST /rooms/[roomId]/announce`.

```bash
bun run test
```

The Server-Sent Events guide (`docs/src/content/docs/guides/server-sent-events.md`, on the site at `/guides/server-sent-events/`) and the WebSockets guide (`docs/src/content/docs/guides/websockets.md`, at `/guides/websockets/`) explain every piece.

## Level 0: enable

Turn the native on; `sse.ts` endpoints stream, and change streams need `events`:

```ts
export default defineConfig({ database: memoryAdapter(), events: {}, realtime: {} });
```

WebSockets come with it: a `ws.ts` file is a socket route, upgraded after authentication and the endpoint's pre-hooks:

```ts
// endpoints/rooms/[roomId]/ws.ts
/** @auth */
export default defineSocket<{ in: In; out: Out }>({
  open: (ws, ctx) => ws.subscribe(`room:${ctx.params.roomId}`),
  on: { say: (ws, message, ctx) => ws.publish(`room:${ctx.params.roomId}`, { type: "said", text: message.text, from: ws.user!.id }) },
});
```

## Level 1: options and environment

`sse.heartbeat`, `sse.maxStreams`, `sse.changes`, `sse.pollInterval` and `sse.buffer` tune the streams, and every option has a `QS_*` variable:

```ts
realtime: { sse: { heartbeat: "15s", maxStreams: 1000 } }
```

```bash
QS_REALTIME_SSE_HEARTBEAT=30s bun .generated/server.ts
```

WebSocket limits are options too, with their variables:

```bash
QS_REALTIME_WEBSOCKETS_MESSAGES=20/10s QS_REALTIME_WEBSOCKETS_MAX_MESSAGE_SIZE=64KB bun .generated/server.ts
```

## Level 2: tags

`@changes` gives an entity a change stream, `@changes events=created` limits the events it offers, and `@changes off` removes it when `sse.changes` is `all`:

```ts
/** @changes events=created */
export type Task = { title: string; status: "open" | "done"; owner?: string };
```

`@socket` gives one socket route its own limits and origins:

```ts
/** @socket messages=5/s origins=https://chat.example */
export default defineSocket({ message: (ws, data) => ws.send(data) });
```

## Level 3: per request

`sse.beforeDeliver` runs for each change and stream with the request, its user and tenant; returning `false` skips the change for that stream, so each user sees only their own tasks:

```ts
realtime: { sse: { beforeDeliver: ({ user, event }) => (event.after as { owner?: string } | null)?.owner === user?.id } }
```

A socket's message rate may be a function of the upgrade request, decided once per connection:

```ts
realtime: { websockets: { messages: ({ tenant }) => (tenant?.plan === "pro" ? "50/s" : "5/s") } }
```

## Level 4: hooks and events

`sse.beforeSend` changes the data of each message, or skips it with `null`:

```ts
realtime: { sse: { beforeSend: ({ data }) => ({ ...(data as object), sentAt: new Date().toISOString() }) } }
```

The WebSocket hooks run around connecting, messages, rooms and closing; `beforeSubscribe` keeps users out of other users' private rooms:

```ts
realtime: { websockets: { beforeSubscribe: ({ ws, room }) => !room.startsWith("private:") || room === `private:${ws.user?.id}` } }
```

## Level 5: override files

A stream is an `sse.ts` file in `endpoints/`, and a project `endpoints/tasks/changes/sse.ts` replaces the generated change stream:

```ts
// endpoints/tasks/changes/sse.ts
export default defineSse((stream) => stream.send({ message: "Changes are paused for maintenance" }));
```

A project `ws.ts` at the path of a project feature's socket replaces it, and the build prints an `Override:` line:

```ts
// endpoints/game/ws.ts replaces features/game/endpoints/game/ws.ts
export default defineSocket({ message: (ws) => ws.send("the game is closed for maintenance") });
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

Room messages reach other workers and replicas through a transport: `"postgres"` uses the project's PostgreSQL database, and any object with `start`, `publish`, `disconnect` and `stop` replaces it, like this test transport for one process:

```ts
realtime: { websockets: { transport: "postgres" } }
```

```ts
import { inProcessTransports } from "@quickservicets/core/testing";

const transports = inProcessTransports();
realtime: { websockets: { transport: transports.transport() } }
```

## Level 7: eject

Copy the native into the project as a `features/realtime/` project feature that replaces it:

```bash
quickservicets eject realtime
```

The ejected copy keeps serving `sse.ts` and `ws.ts` endpoints:

```ts
// features/realtime/sockets.ts is now the project's: the socket server, its rooms and its limits
```
