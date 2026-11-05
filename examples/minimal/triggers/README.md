# triggers

The smallest project that shows the `triggers` native: an `Upload` entity and a trigger, `triggers/new-upload.ts`, that records every new object of a bucket as an `Upload`.

```bash
bun run build
bun run test
```

`bun run test` emits an event to the trigger with `emitTrigger` and reads the created record back, without cloud accounts or Docker.

## Level 0: enable

`triggers: {}` turns the native on; each file in `triggers/` default-exports `trigger({ source, handle })`:

```ts
import { testSource, trigger } from "@quickservicets/core";

export default trigger<{ key: string }>({
  source: testSource({ type: "storage.object.created" }),
  handle: ({ event, repos }) => repos.uploads.create({ key: event.data.key }),
});
```

## Level 1: options and environment

Each trigger takes `concurrency`, `timeout`, `retries` and `retryDelay` in its `options`; `QS_TRIGGERS_POLL=false` stops polling sources in this process, and `QS_TRIGGERS_ENABLED=false` turns the native off:

```ts
export default trigger({ source: testSource(), handle, options: { concurrency: 4, timeout: "1m" } });
```

## Level 2: tags

Not applicable: trigger files are not entities, fields or endpoints.

## Level 3: per request

Not applicable: triggers run for events, not for requests.

## Level 4: hooks and events

Not applicable: the native has no hooks yet; a handler logs through `ctx.log`, which adds `trigger` and `eventId`.

## Level 5: override files

Not applicable: this project ships no feature whose triggers a project file would replace.

## Level 6: replace the implementation

A feature registers the source of a kind, so triggers on that kind run on its events:

```ts
setup(ctx) {
  ctx.feature("triggers").source("fake", { kind: "fake", recognize: () => false, decode: () => [], matches: () => true });
},
```

## Level 7: eject

```bash
bun run quickservicets eject triggers
```

`features/triggers/` then replaces the native, and the example's tests keep passing.
