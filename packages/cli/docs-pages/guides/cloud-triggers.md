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

## CloudEvents

The built-in source `cloudEvents({ type?, source?, path?, auth? })` receives events pushed over HTTP in the CloudEvents format, as Google Eventarc, Pub/Sub push subscriptions, Knative and Azure Event Grid send them. It needs no cloud package: each trigger on it gets the route `POST /_triggers/<trigger name>` (or `path`).

```ts title="triggers/uploads/finalized.ts"
import { cloudEvents, trigger } from "@quickservicets/core";

export default trigger<{ bucket: string; name: string }>({
  source: cloudEvents({ type: "google.cloud.storage.object.v1.*" }),
  handle: ({ event, repos }) => repos.images.create({ key: event.data.name }),
});
```

`type` and `source` match exactly, or by a prefix ending in `*`. The route accepts the three CloudEvents modes:

- **Binary**: the attributes in `ce-id`, `ce-type`, `ce-source` and `ce-specversion: 1.0` headers (optional `ce-time` and `ce-subject`), the data as the body.
- **Structured**: one event as `application/cloudevents+json`.
- **Batch**: an array of events as `application/cloudevents-batch+json`; the trigger runs once per event.

JSON data is parsed; any other content type keeps the bytes. An event missing a required attribute answers 400 `VALIDATION_ERROR` with `Invalid CloudEvent: <reason>`, like `Invalid CloudEvent: missing id`.

### Authentication

- `auth: { bearer: secret("env://PUSH_TOKEN") }` (or a text) compares the `Authorization: Bearer` token in constant time.
- `auth: { oidc: { audience, issuer?, email? } }` checks a JWT signed by the issuer's keys, as Pub/Sub push and Eventarc send with an OIDC token: the signature, `aud`, `iss` (default `https://accounts.google.com`), `exp`, and the service account `email` when given. The keys are fetched through the native's HTTP service `triggers/oidc` and kept for an hour, so `http.mock()` answers them in tests.

A failed check answers 401 `INVALID_SIGNATURE` with `Invalid event credentials`, and the trigger never runs.

### Acknowledgments and the Event Grid handshake

The route answers 204 when every event completed or was discarded, and 500 when any failed, so the sender retries the delivery; the answer never includes error details. Azure Event Grid validates a CloudEvents endpoint with `OPTIONS` and `WebHook-Request-Origin`; the route answers 200 with `WebHook-Allowed-Origin` set to that origin and `WebHook-Allowed-Rate: *`.

Push routes are exempt from the CSRF item and, unless the trigger sets `tenant: true`, from tenancy resolution; they keep the global rate limit and are left out of `/openapi.json`.

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

## Delivery guarantees

Cloud platforms deliver events **at least once**: after a timeout, a crash or a lost acknowledgment, the same event arrives again. Every source gives an event an `id` that stays the same across redeliveries, so handlers can be **idempotent**:

- Write with a key the event decides, like a unique field holding `event.id` or the object key, so a second delivery finds the record instead of creating another.
- Keep an inbox of handled ids (a table with a unique `eventId`, written in the same transaction as the handler's changes) when the work cannot be keyed naturally; a redelivered event then finds its id and returns at once.
- Never rely on order across partitions or unordered queues; ordered sources are described below.

## Failures, retries and batches

A failed event retries and fails the same way on every platform.

- **Discards.** A handler throws `new TriggerDiscard(reason)` for an event that will never succeed, like a file that is not an image. The event ends `discarded`: acknowledged, never retried, and logged with the reason. Any other error ends it `failed`.
- **Function targets.** Failed events go back to the platform through the source's `result`, so the platform's own retry policy applies, like an SQS redelivery after the visibility timeout. `event.attempt` is the platform's delivery count when the source provides it.
- **Polling servers.** A failed event is `nack`ed with `retryInMs`, `retryDelay × 2^(attempt − 1)` capped at 1 hour with ±10% jitter, up to the trigger's `retries`. After the last attempt the source dead-letters it through its `deadLetter` when it has one, and acknowledges it otherwise; the native logs `trigger.event.dead` at error level.

```ts
import { testSource, trigger, TriggerDiscard } from "@quickservicets/core";

export default trigger<{ key: string }>({
  source: testSource(),
  handle({ event }) {
    if (!event.data.key.endsWith(".png")) throw new TriggerDiscard("not an image");
  },
  options: { retries: 5, retryDelay: "30s" },
});
```

A source declares whether its batches are `ordered`, like stream partitions and FIFO queues. In an ordered batch the events of each partition (`attributes.partition`) run one after the other, and the first failed event fails itself and every later event of its partition without running them, so the platform redelivers them in order. In an unordered batch only the failed events are reported, so only they come back.

While `errors` is enabled, a dead event, and a failed event on the platform's last attempt when the source knows it (`lastAttempt(event)`), calls `reportError` with the tags `trigger`, `kind`, `eventId` and `attempt`, never the event's data. While `events` is enabled, the native emits `trigger.event.failed` for every failed attempt and `trigger.event.dead` for each dead event, both with `{ trigger, kind, eventId, attempt, error }`:

```ts
events.on("trigger.event.dead", ({ payload }) => console.error("dead event", payload.trigger, payload.eventId));
```

## Writing a source

A source package (or a project, through `triggers.sources`) implements `TriggerSource` for one cloud service: `recognize` tells its raw platform events apart from others, `decode` turns them into events with stable ids, `matches` checks a trigger's reference (a bucket and prefix, a queue name), and the optional members add the rest:

- `result(outcomes, raw)` answers the platform with only the failed events, like the partial batch responses of SQS, Kinesis and DynamoDB streams.
- `poll(ref, ctx)` pulls events in servers, awaiting `ctx.emit` for back-pressure and acknowledging through `ack`, `nack` (with `retryInMs`) and `deadLetter`; partitioned sources lease partitions with `ctx.checkpoints` and add `triggerCheckpointEntity` to their feature's `entities`.
- `ordered: true` for stream partitions and FIFO queues, and `lastAttempt(event)` when the platform's delivery limit is known.
- `describe(ref)` gives infrastructure hints (below).

A feature that lists `triggers` in `requires`, `after` or `enables` registers its source with `ctx.feature("triggers").source(kind, source)` during setup, and exports a factory for references, like `s3({ bucket, prefix })` returning `{ kind: "s3", bucket, prefix }`. `runTriggerSourceContract(create, { fixtures })` of `@quickservicets/core/testing` runs the source contract as `bun:test` tests: recognition, decoding, matching, stable ids, partial results, polling with fake acknowledgments and no timer left after stop.

```ts
import { runTriggerSourceContract } from "@quickservicets/core/testing";

runTriggerSourceContract(() => queueSource, {
  fixtures: { raw: sampleDelivery, ref: { kind: "queue", queue: "orders" }, otherRef: { kind: "queue", queue: "other" } },
});
```

## Infrastructure hints

`describe(ref)` tells deployment generators what a trigger needs on the platform: the `azure` binding the azure-functions build writes into `trigger-<name>/function.json`, and hints like the event source mapping of a Lambda or the Eventarc trigger of a Cloud Run service. The build fails for a trigger whose source has no hint for the target, like `triggers/<name>: source <kind> cannot run on azure-functions`, instead of deploying a function nothing invokes.

## Testing triggers

The built-in `test` source (`testSource({ type? })`) runs triggers in tests. `emitTrigger(name, data, { attributes? })` of `@quickservicets/core/testing` runs a trigger of the running service as a delivery would and resolves its outcome:

```ts
import { emitTrigger } from "@quickservicets/core/testing";

const outcome = await emitTrigger("uploads/new-image", { key: "a.png" });
// outcome.status is "completed", "failed" or "discarded"
```

For a trigger with `batch: true`, an array of data is one delivery with one event per item.

The `test` source also stands for a cloud queue in a function: `testDelivery(events)` builds the raw event `{ quickservicets: { source: "test", events } }`, and the source answers it with the partial batch response `{ batchItemFailures: [{ itemIdentifier }] }` naming only the failed events, so a test can run the Lambda entry against a fake Runtime API.

Without the native, or without trigger files, no polling loop, timer or route exists.

## Customization levels

| Level | Triggers |
| --- | --- |
| 0. Enable | `triggers: {}` and one trigger file on a built-in source, like `cloudEvents()` |
| 1. Options and environment | The file's `options`, `triggers.overrides.<name>` and `QS_TRIGGERS_OVERRIDES_<NAME>_<OPTION>`; `QS_TRIGGERS_POLL`, `QS_TRIGGERS_POLL_BACKOFF_MAX` |
| 2. Tags | Not applicable: trigger files are not entities, fields or endpoints |
| 3. Per event | `options.when(event)`, which discards with the reason `when` |
| 4. Hooks and events | `beforeHandle`, `afterHandle`, `onFailed` and `ctx.feature("triggers").addHook`; the `trigger.event.failed` and `trigger.event.dead` events |
| 5. Override files | A project file `triggers/<key>/<path>.ts` replaces the trigger a feature ships |
| 6. Replace the implementation | `triggers.sources` and `ctx.feature("triggers").source(kind, source)` |
| 7. Eject | `quickservicets eject triggers` copies the native into `features/triggers/` |

[examples/minimal/triggers](https://github.com/ricardorauber/quickservicets/blob/main/examples/minimal/triggers/README.md) shows every level on a project that runs without cloud accounts.

## Cloud source packages

The sources of each cloud's own event formats (S3, SQS, DynamoDB Streams and Kinesis on AWS; Blob Storage, Service Bus, Cosmos DB and Event Hubs on Azure) ship as packages that register their kinds with this native. Each package adds its section here: its reference factories, the platform events it recognizes, its polling mode and its infrastructure hints.

See the [triggers reference](/reference/features/triggers/) for every option.
