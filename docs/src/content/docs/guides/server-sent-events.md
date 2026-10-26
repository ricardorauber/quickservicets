---
title: Server-Sent Events
description: Stream events to browsers and other clients from sse.ts endpoints, and let them follow a collection's changes live, filtered like the list route and resumed after a reconnect.
sidebar:
  order: 54
---

A dashboard shows the open tasks and must update the moment someone adds one, without polling. Server-Sent Events are plain HTTP responses that stay open and carry one message after the other; browsers read them with `EventSource`, which reconnects by itself. The `realtime` native serves them from `sse.ts` endpoints and gives every chosen collection a change stream. The options, variables, tag, hooks and feature API are listed on the [realtime reference page](/reference/features/realtime/).

The samples come from the example project `examples/minimal/realtime`: a clock stream and a `Task` entity with a change stream.

## `sse.ts` endpoints

With `realtime: {}`, a file named `sse.ts` in `endpoints/` is a `GET` route that streams. It default-exports `defineSse(handler)`; the handler gets the open stream, the repositories and the request.

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  events: {},
  realtime: {},
});
```

```ts title="endpoints/clock/sse.ts"
import { defineSse } from "@quickservicets/core";

/** Sends the server's time every second until the client disconnects. */
export default defineSse((stream) => {
  stream.send({ now: new Date().toISOString() });
  const timer = setInterval(() => stream.send({ now: new Date().toISOString() }), 1000);
  stream.signal.addEventListener("abort", () => clearInterval(timer));
});
```

The endpoint's pre-hooks run first, like on any endpoint: a hook that throws answers its error as JSON and the stream never opens. Post-hooks do not run. A folder holds one `GET` route, so an `sse.ts` next to a `get.ts` fails the build, and so does an `sse.ts` without `realtime: {}` or whose default export is not `defineSse(...)`.

## The stream

- `send(data, { event, id, retry })` writes one message: a string as it is, with one `data:` line per line, any other value as JSON. `event` names it (browsers default to `message`), `id` is what a reconnecting client sends back, and `retry` tells browsers how long to wait before reconnecting. `event` and `id` may not contain line breaks.
- `comment(text)` writes a comment line clients ignore.
- `close()` ends the stream; writes after it are ignored.
- `signal` aborts when the client disconnects or the stream closes; `closed` resolves then.

The stream stays open after the handler resolves, until `close()` or a disconnect; a handler that rejects closes it and is logged as `sse.handler.failed`. `req.lastEventId` holds the `Last-Event-ID` header a reconnecting browser sends, or the `lastEventId` query parameter. The request log entry is written when the stream closes, with its duration and its `messages` count.

## Heartbeats and proxies

An open stream writes a `: ping` comment every `sse.heartbeat` (default `15s`), so proxies and load balancers do not close it as idle. Responses carry `cache-control: no-cache` and `x-accel-buffering: no`, which tells Nginx not to buffer them. Keep the heartbeat shorter than `security.timeouts.idle` (default `30s`); startup warns when it is not.

## Change streams

`@changes` on an entity (or `sse.changes: "all"` for every entity with list routes) adds `GET /<collection>/changes`. It needs `events: {}`.

```ts title="entities/Task.ts"
/** @changes */
export type Task = {
  title: string;
  status: "open" | "done";
  owner?: string;
};
```

Each write sends a message named `created`, `updated` or `deleted`, with the write event's id as its `id` and the data `{ id, type, record }`, where `record` is shaped exactly like an item of `GET /tasks`: hidden fields left out, file URLs computed.

## Filters

The stream takes the list route's `where[...]` filters, `fields` and `exclude`, and `events` (`?events=created,deleted`); `sort`, `limit` and `offset` answer 400. A create is sent when the new record matches, a delete when the deleted record matched, and an update when either side matches; an update whose record left the filter carries `matches: false`, so the client removes it from its list.

```bash
curl -N "http://localhost:3000/tasks/changes?where[status][eq]=open"
```

## Permissions

A change stream runs the hooks of the entity's list route before opening, so whoever may not list tasks may not follow them. To filter per record and per user, use `sse.beforeDeliver` (below).

## Resume and `reset`

Every change message has the event's id, and the first message of a stream carries `retry: 3000`. A browser that reconnects sends the last id it saw as `Last-Event-ID`; the stream first sends the missed changes that match its filters, in order, then the live ones, without gaps or duplicates. When it cannot, it sends one `reset` message and then the live changes, and the client reloads the list:

| Reason | When |
| --- | --- |
| `unknown-id` | The id is not an event id, or the source never had it. |
| `expired` | The source no longer keeps it (outside the ring buffer or the outbox retention). |
| `too-many` | More than 10000 changes were missed. |

## Workers and the outbox

Without the outbox, each worker keeps its own last `sse.buffer` (default 1000) changes in memory and sees only its own writes; with `server.workers` above 1, startup warns. With `events: { outbox: true }`, the changes of the covered entities are stored in the outbox log, and every worker and replica with an open change stream reads it every `sse.pollInterval` (default `1s`), so a stream on any instance gets every change once, and resumes reach back as far as the outbox retention. Polling runs only while a stream is open.

## Limits

Each worker keeps at most `sse.maxStreams` (default 1000) streams open; more answer `503 Too many open streams` with `Retry-After: 5`. On shutdown, every open stream is closed before the listener closes, and browsers reconnect to another instance.

## Customization

1. Enable: `realtime: {}`, with `events: {}` for change streams.
2. Options and variables: `sse.heartbeat`, `sse.maxStreams`, `sse.changes`, `sse.pollInterval`, `sse.buffer` and `sse.events`, each with its variable, such as `QS_REALTIME_SSE_HEARTBEAT=30s`, `QS_REALTIME_SSE_MAX_STREAMS=200` and `QS_REALTIME_SSE_ENABLED=false`.
3. Tags: `@changes events=created` limits the events an entity's stream offers; asking for others answers 400.
4. Per request: `sse.beforeDeliver` receives `{ req, user, tenant, event, entity }` for each change and stream; `false` skips the change for that stream, and a throw skips it and is logged.

```ts
realtime: { sse: { beforeDeliver: ({ user, event }) => (event.after as { owner?: string } | null)?.owner === user?.id } }
```

5. Hooks: `sse.beforeSend` receives `{ req, event, data }` before each message and returns changed data, or `null` to skip it.
6. Override files: a project `endpoints/tasks/changes/sse.ts` replaces the generated change stream, with an `Override:` line in the build output.
7. A source: `sse.changeSource` replaces the outbox and ring buffer with any object that has `subscribe(entities, onEvent)` and `replay(entities, afterId, limit)`, such as one fed by Redis or PostgreSQL `LISTEN/NOTIFY`.
8. Eject: `quickservicets eject realtime` copies the native into `features/realtime/`.

Other features reach the native with `ctx.feature("realtime")`, which offers `beforeDeliver(fn)`, `beforeSend(fn)` and `publish(entity, event)`, sending a change to this worker's open streams without a write.

## In the browser

```ts
const source = new EventSource("/tasks/changes?where[status][eq]=open");
source.addEventListener("created", (message) => addTask(JSON.parse(message.data).record));
source.addEventListener("updated", (message) => {
  const { record, matches } = JSON.parse(message.data);
  if (matches === false) removeTask(record.id);
  else updateTask(record);
});
source.addEventListener("deleted", (message) => removeTask(JSON.parse(message.data).id));
source.addEventListener("reset", () => reloadTasks());
```

`EventSource` reconnects by itself and sends `Last-Event-ID`; it cannot send headers, so authenticate with a cookie, or pass `lastEventId` in the query string when you reconnect yourself.

## See also

- [`realtime` reference](/reference/features/realtime/): every option with its variable, the `@changes` tag, the hooks and the feature API.
- [Events](/guides/events/): the write events and the outbox change streams are built on.
- [Endpoints](/guides/endpoints/): the files and hooks `sse.ts` shares with every endpoint.
