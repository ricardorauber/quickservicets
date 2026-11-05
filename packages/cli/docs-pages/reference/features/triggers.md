# triggers

> Trigger files in triggers/ that react to cloud events through registered sources, with the repositories like jobs.

Trigger files in triggers/ that react to cloud events through registered sources, with the repositories like jobs.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
triggers: {}
```

It is not enabled by default: turn it on with `triggers: {}` or `QS_TRIGGERS_ENABLED=true`, and off with `triggers: false` or `QS_TRIGGERS_ENABLED=false`.

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `triggers.enabled` | `boolean` | `true` | `QS_TRIGGERS_ENABLED` | no | Turns the feature off when false. |
| `triggers.database` | `string` | — | `QS_TRIGGERS_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |

## Feature API

Other features reach it with `ctx.feature("triggers")` in their setup, listing `triggers` in `requires` or `after`.

### `source`

```ts
source(kind: string, source: TriggerSource<never>): void;
```

Registers the source of a kind, so triggers whose reference names that kind run on its events. Only available
during the setup of another feature; a kind registered twice fails startup naming both owners.

## Trigger files

Each file in `triggers/` default-exports `trigger({ source, handle, batch?, options? })`; its path without extension is its name (`triggers/uploads/new-image.ts` is `uploads/new-image`), and a trigger a feature ships in its folder is named `<key>/<path>`. The build lists every name in `TriggerNames` of `.generated/types.ts`.

```ts
import { testSource, trigger } from "@quickservicets/core";

export default trigger<{ key: string }>({
  source: testSource(),
  async handle({ event, repos, log }) {
    log.info("new image", { key: event.data.key });
    await repos.images.create({ key: event.data.key });
  },
  options: { concurrency: 1, timeout: "30s", retries: 3, retryDelay: "10s" },
});
```

`handle` runs once per event, or once per delivery with `ctx.events` when `batch: true`. It receives `{ event, events?, trigger, repos, log, signal, http, files, queue?, tenant?, attempt }`: `log` adds `trigger` and `eventId`, `http` sends the event id as `x-request-id`, and writes carry the actor `job:trigger/<name>`. An event is `{ id, kind, type, time, subject?, data, attributes, attempt }`, with an `id` that stays the same across redeliveries.

## Sources

A source is a `TriggerSource`: `kind`, `recognize(platform, raw)`, `decode(raw)` returning events and `matches(ref, event)`, plus the optional `poll(ref, ctx)`, `result(outcomes, raw)`, `push` and `describe(ref)`. A feature listing `triggers` in `requires`, `after` or `enables` registers one during its setup with `ctx.feature("triggers").source(kind, source)`. A trigger on a kind no feature registers fails startup with `triggers/<name> uses source <kind>, which no feature registers; enable the feature that provides it`.

The built-in kind `test` (`testSource({ type? })`) runs triggers in tests: `emitTrigger(name, data, { attributes? })` of `@quickservicets/core/testing` runs a trigger as a delivery would and resolves its outcome; for a trigger with `batch: true`, an array of data is one delivery of one event per item.
