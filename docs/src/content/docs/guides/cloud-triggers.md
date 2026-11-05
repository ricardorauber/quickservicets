---
title: Cloud triggers
description: React to cloud events (a new object in a bucket, a message on a cloud queue, a change feed record) with trigger files that receive the repositories like jobs.
sidebar:
  order: 66
---

A trigger is a file in `triggers/` that runs when a cloud event arrives: a new object in a bucket, a message on a cloud queue, a record of a change feed. It receives the repositories like a job does. Each cloud's event formats come from a *source*, registered through one contract, so the same trigger file works wherever its source does.

The `triggers` native is off until you turn it on:

```ts
triggers: {},
```

## Trigger files

Each file default-exports `trigger({ source, handle, batch?, options? })`. Its path without extension is its name: `triggers/uploads/new-image.ts` is the trigger `uploads/new-image`. A trigger a feature ships in its own folder is named `<key>/<path>`, like a feature's jobs.

```ts title="triggers/uploads/new-image.ts"
import { testSource, trigger } from "@quickservicets/core";

export default trigger<{ key: string }>({
  source: testSource(),
  async handle({ event, repos, log }) {
    log.info("new image", { key: event.data.key });
    await repos.images.create({ key: event.data.key });
  },
});
```

`handle` runs once per event. With `batch: true` it runs once per delivery and reads every event in `ctx.events`. The options are `concurrency` (default 1), `timeout` (default `30s`), `retries` (default 3) and `retryDelay` (default `10s`).

The build lists every trigger name in `TriggerNames` of `.generated/types.ts`, typed with the data each trigger declares. A file whose default export is not `trigger(...)` fails the build with `triggers/<file>: must default-export trigger(...)`.

## The handler context

`handle` receives:

| Field | What it is |
| --- | --- |
| `event` | The event: `{ id, kind, type, time, subject?, data, attributes, attempt }`; in a batch trigger, the first event |
| `events` | Every event of the delivery, with `batch: true` |
| `trigger` | The trigger's name |
| `repos` | The typed repositories |
| `log` | The service logger, adding `trigger` and `eventId` to each entry |
| `signal` | Aborted when the event runs out of time or the service shuts down |
| `http` | The outgoing HTTP client, sending the event id as `x-request-id` |
| `files` | `createFile`, `openFile` and `fileUrl` |
| `queue` | Adds queue messages, while the `queues` native runs |
| `attempt` | The delivery attempt, starting at 1 |

Writes run as the actor `job:trigger/<name>`, so history versions and write events name the trigger. An event's `id` stays the same when the platform delivers it again.

## Sources

A source is a `TriggerSource`:

```ts
interface TriggerSource {
  kind: string;
  recognize(platform: string, raw: unknown): boolean;
  decode(raw: unknown): TriggerEvent[] | Promise<TriggerEvent[]>;
  matches(ref: TriggerSourceRef, event: TriggerEvent): boolean;
  poll?(ref, ctx): void | Promise<void>;
  result?(outcomes, raw): unknown;
  push?: unknown;
  describe?(ref): TriggerSourceHints;
}
```

A trigger names its source with a reference made by the source's factory, like `testSource()`; the reference's `kind` picks the source and its other fields are what `matches` checks. A feature that lists `triggers` in `requires`, `after` or `enables` registers a source during its setup:

```ts
setup(ctx) {
  ctx.feature("triggers").source("fake", fakeSource);
},
```

A trigger on a kind no feature registers fails startup with `triggers/<name> uses source <kind>, which no feature registers; enable the feature that provides it`, and a kind registered by two features fails naming both.

## Testing triggers

The built-in `test` source (`testSource({ type? })`) runs triggers in tests. `emitTrigger(name, data, { attributes? })` of `@quickservicets/core/testing` runs a trigger of the running service as a delivery would and resolves its outcome:

```ts
import { emitTrigger } from "@quickservicets/core/testing";

const outcome = await emitTrigger("uploads/new-image", { key: "a.png" });
// outcome.status is "completed", "failed" or "discarded"
```

For a trigger with `batch: true`, an array of data is one delivery with one event per item.

Without the native, or without trigger files, no polling loop, timer or route exists.

See the [triggers reference](/reference/features/triggers/) for every option.
