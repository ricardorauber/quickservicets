# realtime

The smallest project that shows the `realtime` native: an `endpoints/clock/sse.ts` file that streams the server's time to clients as Server-Sent Events, with heartbeats and disconnect handling.

```bash
bun run test
```

## Level 0: enable

Turn the native on; every `sse.ts` endpoint then streams Server-Sent Events:

```ts
export default defineConfig({ database: memoryAdapter(), realtime: {} });
```

## Level 1: options and environment

`sse.heartbeat` sets how often an idle stream pings and `sse.maxStreams` how many streams a worker keeps open; every option has a `QS_*` variable:

```ts
realtime: { sse: { heartbeat: "15s", maxStreams: 1000 } }
```

```bash
QS_REALTIME_SSE_HEARTBEAT=30s bun .generated/server.ts
```

## Level 2: tags

`@changes` gives an entity a change stream at `GET /<collection>/changes`, filtered like its list route (it needs `events: {}`):

```ts
/** @changes */
export type Task = { title: string; status: "open" | "done" };
```

## Level 3: per request

Not applicable: no option is resolved per request yet.

## Level 4: hooks and events

Not applicable: the native declares no hook yet.

## Level 5: override files

A stream is an `sse.ts` file in `endpoints/`, with the same hooks as any endpoint:

```ts
// endpoints/clock/sse.ts
export default defineSse((stream) => {
  const timer = setInterval(() => stream.send({ now: new Date().toISOString() }), 1000);
  stream.signal.addEventListener("abort", () => clearInterval(timer));
});
```

## Level 6: replace the implementation

Not applicable: streams are served by the native only so far.

## Level 7: eject

Copy the native into the project as a `features/realtime/` project feature that replaces it:

```bash
quickservice eject realtime
```
