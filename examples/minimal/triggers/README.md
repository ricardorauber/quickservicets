# triggers

The smallest project that shows the `triggers` native: an `Upload` entity, a trigger `triggers/new-upload.ts` that records every new object of a bucket as an `Upload` from the CloudEvents the storage service pushes, and a trigger `triggers/billing-events.ts` on every `billing.*` event. It runs without cloud accounts or Docker.

```bash
bun run build          # a server: POST /_triggers/new-upload and /_triggers/billing-events
bun run build:lambda   # a function: the same triggers, dispatched from Lambda events
bun run test
```

`bun run test` posts binary and structured CloudEvents to the push routes, emits events with `emitTrigger`, and runs the Lambda entry against a fake Runtime API with a batch of `test` source events of which one fails, checking that only that event comes back in `batchItemFailures`.

## Level 0: enable

`triggers: {}` turns the native on; each file in `triggers/` default-exports `trigger({ source, handle })`, here on the built-in CloudEvents source:

```ts
import { cloudEvents, trigger } from "@quickservicets/core";

export default trigger<{ key: string }>({
  source: cloudEvents({ type: "storage.object.created" }),
  handle: ({ event, repos }) => repos.uploads.create({ key: event.data.key }),
});
```

## Level 1: options and environment

Each trigger takes `concurrency`, `timeout`, `retries` and `retryDelay` in its `options`, over which `triggers.overrides.<name>` and `QS_TRIGGERS_OVERRIDES_<NAME>_<OPTION>` win:

```ts
triggers: { overrides: { "new-upload": { concurrency: 4 } } },
```

```bash
QS_TRIGGERS_OVERRIDES_NEW_UPLOAD_CONCURRENCY=8 bun run dev
```

## Level 2: tags

Not applicable: trigger files are not entities or endpoints, so no tag applies to them.

## Level 3: per request

Triggers run per event: `options.when(event)` decides before `handle`, and `false` discards the event with the reason `when`:

```ts
export default trigger<{ key: string }>({
  source: cloudEvents({ type: "storage.object.created" }),
  options: { when: (event) => (event.data as { key: string }).key.endsWith(".png") },
  handle: ({ event, repos }) => repos.uploads.create({ key: event.data.key }),
});
```

## Level 4: hooks and events

`onFailed` runs after each failed event, with `final` on its last attempt; with `events: {}`, a listener receives `trigger.event.dead`:

```ts
triggers: { onFailed: ({ trigger, event, final }) => final && console.error(`${trigger} gave up on ${event.id}`) },
```

```ts
events.on("trigger.event.dead", ({ payload }) => console.error("dead event", payload.trigger, payload.eventId));
```

## Level 5: override files

A project file `triggers/<key>/<path>.ts` replaces the trigger `<key>/<path>` a feature ships. With a small project feature `features/audit/` shipping `features/audit/triggers/sync.ts`, this file replaces it and the build prints `Override: triggers/audit/sync.ts replaces features/audit/triggers/sync.ts from audit`:

```ts
// triggers/audit/sync.ts
import { cloudEvents, trigger } from "@quickservicets/core";

export default trigger({ source: cloudEvents({ type: "audit.*" }), handle: ({ log, event }) => log.info("audit", { type: event.type }) });
```

## Level 6: replace the implementation

`sources` registers a source of the project, so triggers on its kind run on its events, like the cloud source packages do:

```ts
triggers: {
  sources: [
    {
      kind: "fake",
      recognize: (_platform, raw) => Array.isArray((raw as { fake?: unknown }).fake),
      decode: (raw) => (raw as { fake: string[] }).fake.map((id) => ({ id, kind: "fake", type: "fake.event", time: new Date(), data: {}, attributes: {}, attempt: 1 })),
      matches: () => true,
    },
  ],
},
```

## Level 7: eject

```bash
bun run quickservicets eject triggers
```

`features/triggers/` then replaces the native, and the example's tests keep passing.
