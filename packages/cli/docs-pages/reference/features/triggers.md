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
| `triggers.poll` | `boolean` | `true` | `QS_TRIGGERS_POLL` | no | Runs the polls of sources that pull events (like stream shards and cloud queues) in server targets; false leaves pulling to other processes. |
| `triggers.pollBackoff.min` | `duration` | `"1s"` | `QS_TRIGGERS_POLL_BACKOFF_MIN` | no | The delay before a failed poll starts again, doubled after each further failure. |
| `triggers.pollBackoff.max` | `duration` | `"30s"` | `QS_TRIGGERS_POLL_BACKOFF_MAX` | no | The longest delay before a failed poll starts again. |
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

### `dispatch`

```ts
dispatch(platform: string, raw: unknown, options?: DispatchOptions): Promise<TriggerDispatch | undefined>;
```

Hands a raw platform event (`platform` is `lambda`, `azure-functions` or another target) to the triggers it
belongs to: the first registered source whose `recognize` accepts it decodes it, and every trigger whose reference
`matches` an event handles it. Resolves undefined when no source recognizes the event.

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

## Function targets

On `lambda`, every event that is neither HTTP nor a job invocation goes to `ctx.feature("triggers").dispatch(platform, raw)`: the registered sources are asked in registration order, the first whose `recognize` accepts the event decodes it, and each event goes to every trigger of that kind whose reference `matches` it, in file name order. An event no source recognizes fails with `Unsupported Lambda event`; an event no trigger takes logs `trigger.event.unmatched` and completes, so it is not redelivered forever.

Each handler is limited by the smaller of its `timeout` and the time left before the platform's deadline less 500 ms, its `signal` aborted at that limit. The source's `result(outcomes, raw)` builds the invocation's answer, like a partial batch response; without it, a failed event fails the invocation. Each event logs `trigger.event.started` and `trigger.event.completed`, `trigger.event.failed` or `trigger.event.discarded` with `trigger`, `kind`, `eventId`, `attempt` and `durationMs`.

On `azure-functions` the build writes `trigger-<name>/function.json` (with `/` as `-`) from the binding of the source's `describe(ref).azure`, and the custom handler dispatches that function's invocations to its trigger; a source without an Azure binding fails the build with `triggers/<name>: source <kind> cannot run on azure-functions`.

## Polling in servers

In server targets (`server`, `binary`, and `cloud-run` with `deploy.cloudRun.cpuAlwaysAllocated`) and while `poll` is true, every worker starts the `poll(ref, ctx)` of each trigger whose source has one, in `onStart`. The poll receives `{ emit(events, { ack, nack }), signal, log, checkpoints }`: `emit` runs the trigger with its `concurrency` and resolves once every event was handled (back-pressure), calling `ack` or `nack` per outcome. A poll that throws logs `trigger.poll.failed` and starts again after a delay doubling from `pollBackoff.min` to `pollBackoff.max`, back to the minimum after a successful emission. On a shutdown signal the polls' signals abort; at stop the running handlers finish within `jobs.shutdownGrace` and the held leases are released.

A source that reads partitions (stream shards) keeps its positions with `ctx.checkpoints`: `claim(partitions, { ttl })` resolves the partitions this worker leases with their saved positions, `renew()` extends the leases, `save(partition, position)` writes only while this worker holds the lease, and `release(partition)` frees one at once. They live in the shared system entity `TriggerCheckpoint` (`trigger`, `partition`, `position`, `owner`, `leaseUntil`, unique on trigger and partition), which the feature registering such a source adds to its `entities` as `triggerCheckpointEntity`; several features adding it keep one table.

## Failures, retries and batches

A handler that throws `new TriggerDiscard(reason)` ends the event `discarded`: acknowledged without a retry and logged with the reason. Any other error ends it `failed`.

In function targets a failed event goes back to the platform through the source's `result`, so the platform's own retry policy applies, and `event.attempt` is the platform's delivery count when the source knows it. In polling mode a failed event is `nack`ed with `retryInMs` = `retryDelay × 2^(attempt − 1)`, at most 1 hour with ±10% jitter, up to the trigger's `retries`; after the last attempt the source dead-letters it through `deadLetter` when it has one (otherwise it is acknowledged) and the native logs `trigger.event.dead` at error level.

A source with `ordered: true` (stream partitions, FIFO queues) hands batches in order: the events of one partition (`attributes.partition`) run one after the other, and the first failure fails it and every later event of the partition without running them; in unordered batches only the failed events are reported.

While `errors` is enabled, a dead event, and a failed event on the platform's last attempt (when the source's `lastAttempt(event)` says so), calls `reportError` with the tags `trigger`, `kind`, `eventId` and `attempt`, never the event's data. While `events` is enabled, the native emits `trigger.event.failed` for every failed attempt and `trigger.event.dead` for a dead event, with `{ trigger, kind, eventId, attempt, error }`.

## Sources

A source is a `TriggerSource`: `kind`, `recognize(platform, raw)`, `decode(raw)` returning events and `matches(ref, event)`, plus the optional `poll(ref, ctx)`, `result(outcomes, raw)`, `push` and `describe(ref)`. A feature listing `triggers` in `requires`, `after` or `enables` registers one during its setup with `ctx.feature("triggers").source(kind, source)`. A trigger on a kind no feature registers fails startup with `triggers/<name> uses source <kind>, which no feature registers; enable the feature that provides it`.

The built-in kind `test` (`testSource({ type? })`) runs triggers in tests: `emitTrigger(name, data, { attributes? })` of `@quickservicets/core/testing` runs a trigger as a delivery would and resolves its outcome; for a trigger with `batch: true`, an array of data is one delivery of one event per item.
