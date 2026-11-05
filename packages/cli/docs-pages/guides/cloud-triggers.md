# Cloud triggers

> React to cloud events (a new object in a bucket, a message on a cloud queue, a change feed record) with trigger files that receive the repositories like jobs.

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

## Function targets

A function deployed with `--target lambda` handles HTTP requests and cloud events alike. Every Lambda event that is neither HTTP nor a job invocation goes to the triggers: the registered sources are asked in registration order, the first that recognizes the event decodes it, and each decoded event goes to every trigger of that kind whose reference matches it, in file name order. An event no source recognizes fails with `Unsupported Lambda event`. An event no trigger takes logs `trigger.event.unmatched` at warning level and counts as completed, so a misrouted event is not redelivered forever.

Events of one invocation run with each trigger's `concurrency`. Each handler stops at the smaller of its `timeout` and the time left before the platform's deadline less 500 milliseconds: its `signal` aborts and the event fails.

The source's `result(outcomes, raw)` builds the answer the platform receives, like the partial batch response of a queue, so only the failed events come back. A source without `result` fails the whole invocation when an event failed. Every event logs `trigger.event.started`, then `trigger.event.completed`, `trigger.event.failed` or `trigger.event.discarded`, with `trigger`, `kind`, `eventId`, `attempt` and `durationMs`.

On `--target azure-functions`, the build writes one function per trigger, `trigger-<name>/function.json` with `/` as `-` (`trigger-uploads-new-image`), from the binding the source's `describe(ref).azure` gives, and the custom handler dispatches that function's invocations to its trigger. A source without an Azure binding fails the build with `triggers/<name>: source <kind> cannot run on azure-functions`.

## Polling in servers

The same trigger files run on long-running servers, where the service pulls the events instead of the platform pushing them. In server targets (`server`, `binary`, and `cloud-run` with `deploy.cloudRun.cpuAlwaysAllocated: true`), every worker starts the `poll(ref, ctx)` of each trigger whose source has one. On function targets, or with `poll: false` (`QS_TRIGGERS_POLL=false`), no poll starts.

```ts
triggers: { poll: true, pollBackoff: { min: "1s", max: "30s" } },
```

A poll receives `{ emit, signal, log, checkpoints }`. `emit(events, { ack, nack })` runs the trigger with its `concurrency` and resolves once every event was handled, so a poll that awaits it never pulls faster than the trigger handles; it calls `ack` for each completed or discarded event and `nack` for each failed one. A poll that throws logs `trigger.poll.failed` and starts again after a delay that doubles from `pollBackoff.min` to `pollBackoff.max`, and goes back to the minimum after a successful emission. Polls wait with timers and awaits only, never a busy loop.

Sources that read partitions, like stream shards, share their positions safely across workers and replicas with `ctx.checkpoints`:

| Call | What it does |
| --- | --- |
| `claim(partitions, { ttl })` | Leases the free or expired partitions for `ttl`, resolving the ones this worker holds with their saved positions |
| `renew()` | Extends the leases this worker holds |
| `save(partition, position)` | Saves a position, only while this worker still holds the lease |
| `release(partition)` | Frees a partition at once |

Each partition is read by one worker at a time and resumed from its saved position by another once the lease of a worker that crashed expires. The leases live in the shared system entity `TriggerCheckpoint` (`trigger`, `partition`, `position`, `owner`, `leaseUntil`, unique on trigger and partition); the feature that registers such a source adds `triggerCheckpointEntity` to its `entities`, so the table exists only while it is enabled.

On a shutdown signal the polls' signals abort. While the service stops, running handlers finish within `jobs.shutdownGrace`, then the held leases are released, so another instance continues without waiting for them to expire.

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
