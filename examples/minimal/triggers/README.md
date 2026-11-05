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

Each trigger takes `concurrency`, `timeout`, `retries` and `retryDelay` in its `options`, over which `triggers.overrides.<name>` and `QS_TRIGGERS_OVERRIDES_<NAME>_<OPTION>` win:

```ts
triggers: { overrides: { "new-upload": { concurrency: 4 } } },
```

```bash
QS_TRIGGERS_OVERRIDES_NEW_UPLOAD_CONCURRENCY=8 bun run dev
```

## Level 2: tags

Not applicable: trigger files are not entities, fields or endpoints.

## Level 3: per request

Triggers run per event: `options.when(event)` decides before `handle`, and `false` discards the event with the reason `when`:

```ts
export default trigger<{ key: string }>({ source: testSource(), options: { when: (event) => (event.data as { key: string }).key.endsWith(".png") }, handle });
```

## Level 4: hooks and events

`beforeHandle`, `afterHandle` and `onFailed` run around every event:

```ts
triggers: { onFailed: ({ trigger, event, final }) => final && console.error(`${trigger} gave up on ${event.id}`) },
```

## Level 5: override files

Not applicable: this project ships no feature whose triggers a project file would replace.

## Level 6: replace the implementation

`sources` registers a source of the project, so triggers on its kind run on its events:

```ts
triggers: { sources: [{ kind: "fake", recognize: () => false, decode: () => [], matches: () => true }] },
```

## Level 7: eject

```bash
bun run quickservicets eject triggers
```

`features/triggers/` then replaces the native, and the example's tests keep passing.
