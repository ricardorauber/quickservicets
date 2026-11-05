import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { boolean, defineFeature, duration, isFunctionTarget, object, parseDuration, safeLog, setUpDependents, systemClock, type JobClock, type Repositories, type ResolvedConfig } from "../public.ts";
import { checkpointStore, MISSING_CHECKPOINTS, type TriggerCheckpoints } from "./checkpoints.ts";
import { startPoller, type Poller } from "./poll.ts";
import { runTriggerEvents } from "./run.ts";
import type { TriggerEvent, TriggerOutcome, TriggerSource } from "./source.ts";
import { dispatchPlatformEvent, NOT_ENABLED, overallStatus, running, sharedState, type DispatchOptions, type EmitTriggerOptions, type RunningTriggers, type TriggerDispatch, type TriggerEmission } from "./state.ts";
import { TEST_SOURCE_KIND, testTriggerSource } from "./test-source.ts";
import { isTriggerDefinition, type TriggerDefinition } from "./trigger.ts";

/** The public API of the `triggers` native, `ctx.feature("triggers")` in a feature that lists it in `requires`, `after` or `enables`. */
export interface TriggersApi {
  /**
   * Registers the source of a kind, so triggers whose reference names that kind run on its events. Only available
   * during the setup of another feature; a kind registered twice fails startup naming both owners.
   */
  source(kind: string, source: TriggerSource<never>): void;
  /**
   * Hands a raw platform event (`platform` is `lambda`, `azure-functions` or another target) to the triggers it
   * belongs to: the first registered source whose `recognize` accepts it decodes it, and every trigger whose reference
   * `matches` an event handles it. Resolves undefined when no source recognizes the event.
   */
  dispatch(platform: string, raw: unknown, options?: DispatchOptions): Promise<TriggerDispatch | undefined>;
}

/** The sources registered in this process, by kind, with the feature that registered each. */
const registered = sharedState("sources", () => ({ sources: new Map<string, { source: TriggerSource; owner: string }>() }));

/** The clock pollers schedule their restarts with; tests set a fake one. */
const clocks = sharedState("clock", () => ({ current: systemClock as JobClock }));

/** Sets the clock of the pollers' restart delays (default: the system clock), for tests. */
export function setTriggersClock(clock: JobClock = systemClock): void {
  clocks.current = clock;
}

const options = object({
  poll: boolean().default(true).describe("Runs the polls of sources that pull events (like stream shards and cloud queues) in server targets; false leaves pulling to other processes."),
  pollBackoff: object({
    min: duration().default("1s").describe("The delay before a failed poll starts again, doubled after each further failure."),
    max: duration().default("30s").describe("The longest delay before a failed poll starts again."),
  })
    .default({})
    .describe("How long a failed poll waits before it starts again; the delay goes back to min after a successful emission."),
});

/**
 * Whether the deploy target pulls events: servers and binaries do, and cloud-run with `cpuAlwaysAllocated`; function
 * targets, where the platform pushes events, do not.
 */
export function targetPolls(config: Pick<ResolvedConfig, "features">): boolean {
  const deploy = config.features.find((feature) => feature.key === "deploy")?.options as { target?: string; cloudRun?: { cpuAlwaysAllocated?: boolean } } | undefined;
  const target = deploy?.target ?? "server";
  if (isFunctionTarget(target)) return false;
  return target !== "cloud-run" || deploy?.cloudRun?.cpuAlwaysAllocated === true;
}

/** The startup failure of a trigger whose source kind no feature registers. */
export const missingSource = (name: string, kind: string) => `triggers/${name} uses source ${kind}, which no feature registers; enable the feature that provides it`;

/** The startup failure of a kind registered twice. */
export const duplicateSource = (kind: string, first: string, second: string) => `Trigger source ${kind} is registered by ${first} and ${second}; keep one`;

/** The methods every source must have. */
const SOURCE_METHODS = ["recognize", "decode", "matches"] as const;

/** Why a value is not a source, or undefined when it is one. */
export function sourceProblem(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null) return "expected a TriggerSource object";
  const missing = SOURCE_METHODS.filter((method) => typeof (source as Record<string, unknown>)[method] !== "function");
  return missing.length > 0 ? `the TriggerSource is missing ${missing.join(", ")}` : undefined;
}

/**
 * The `triggers` native: files in `triggers/` that react to cloud events (a new object in a bucket, a message on a
 * cloud queue, a change feed record) with the repositories, like jobs, while each cloud's event formats come from
 * sources registered through one contract. Off unless `triggers: {}` (or `QS_TRIGGERS_ENABLED=true`) is set.
 */
export const triggersFeature = defineFeature({
  key: "triggers",
  docs: {
    summary: "Trigger files in triggers/ that react to cloud events through registered sources, with the repositories like jobs.",
    sections: [
      {
        title: "Trigger files",
        text: [
          "Each file in `triggers/` default-exports `trigger({ source, handle, batch?, options? })`; its path without extension is its name (`triggers/uploads/new-image.ts` is `uploads/new-image`), and a trigger a feature ships in its folder is named `<key>/<path>`. The build lists every name in `TriggerNames` of `.generated/types.ts`.",
          "",
          "```ts",
          "import { testSource, trigger } from \"@quickservicets/core\";",
          "",
          "export default trigger<{ key: string }>({",
          "  source: testSource(),",
          "  async handle({ event, repos, log }) {",
          "    log.info(\"new image\", { key: event.data.key });",
          "    await repos.images.create({ key: event.data.key });",
          "  },",
          "  options: { concurrency: 1, timeout: \"30s\", retries: 3, retryDelay: \"10s\" },",
          "});",
          "```",
          "",
          "`handle` runs once per event, or once per delivery with `ctx.events` when `batch: true`. It receives `{ event, events?, trigger, repos, log, signal, http, files, queue?, tenant?, attempt }`: `log` adds `trigger` and `eventId`, `http` sends the event id as `x-request-id`, and writes carry the actor `job:trigger/<name>`. An event is `{ id, kind, type, time, subject?, data, attributes, attempt }`, with an `id` that stays the same across redeliveries.",
        ].join("\n"),
      },
      {
        title: "Function targets",
        text: [
          "On `lambda`, every event that is neither HTTP nor a job invocation goes to `ctx.feature(\"triggers\").dispatch(platform, raw)`: the registered sources are asked in registration order, the first whose `recognize` accepts the event decodes it, and each event goes to every trigger of that kind whose reference `matches` it, in file name order. An event no source recognizes fails with `Unsupported Lambda event`; an event no trigger takes logs `trigger.event.unmatched` and completes, so it is not redelivered forever.",
          "",
          "Each handler is limited by the smaller of its `timeout` and the time left before the platform's deadline less 500 ms, its `signal` aborted at that limit. The source's `result(outcomes, raw)` builds the invocation's answer, like a partial batch response; without it, a failed event fails the invocation. Each event logs `trigger.event.started` and `trigger.event.completed`, `trigger.event.failed` or `trigger.event.discarded` with `trigger`, `kind`, `eventId`, `attempt` and `durationMs`.",
          "",
          "On `azure-functions` the build writes `trigger-<name>/function.json` (with `/` as `-`) from the binding of the source's `describe(ref).azure`, and the custom handler dispatches that function's invocations to its trigger; a source without an Azure binding fails the build with `triggers/<name>: source <kind> cannot run on azure-functions`.",
        ].join("\n"),
      },
      {
        title: "Polling in servers",
        text: [
          "In server targets (`server`, `binary`, and `cloud-run` with `deploy.cloudRun.cpuAlwaysAllocated`) and while `poll` is true, every worker starts the `poll(ref, ctx)` of each trigger whose source has one, in `onStart`. The poll receives `{ emit(events, { ack, nack }), signal, log, checkpoints }`: `emit` runs the trigger with its `concurrency` and resolves once every event was handled (back-pressure), calling `ack` or `nack` per outcome. A poll that throws logs `trigger.poll.failed` and starts again after a delay doubling from `pollBackoff.min` to `pollBackoff.max`, back to the minimum after a successful emission. On a shutdown signal the polls' signals abort; at stop the running handlers finish within `jobs.shutdownGrace` and the held leases are released.",
          "",
          "A source that reads partitions (stream shards) keeps its positions with `ctx.checkpoints`: `claim(partitions, { ttl })` resolves the partitions this worker leases with their saved positions, `renew()` extends the leases, `save(partition, position)` writes only while this worker holds the lease, and `release(partition)` frees one at once. They live in the shared system entity `TriggerCheckpoint` (`trigger`, `partition`, `position`, `owner`, `leaseUntil`, unique on trigger and partition), which the feature registering such a source adds to its `entities` as `triggerCheckpointEntity`; several features adding it keep one table.",
        ].join("\n"),
      },
      {
        title: "Sources",
        text: [
          "A source is a `TriggerSource`: `kind`, `recognize(platform, raw)`, `decode(raw)` returning events and `matches(ref, event)`, plus the optional `poll(ref, ctx)`, `result(outcomes, raw)`, `push` and `describe(ref)`. A feature listing `triggers` in `requires`, `after` or `enables` registers one during its setup with `ctx.feature(\"triggers\").source(kind, source)`. A trigger on a kind no feature registers fails startup with `triggers/<name> uses source <kind>, which no feature registers; enable the feature that provides it`.",
          "",
          "The built-in kind `test` (`testSource({ type? })`) runs triggers in tests: `emitTrigger(name, data, { attributes? })` of `@quickservicets/core/testing` runs a trigger as a delivery would and resolves its outcome; for a trigger with `batch: true`, an array of data is one delivery of one event per item.",
        ].join("\n"),
      },
    ],
  },
  options,
  folders: {
    triggers: {
      dir: "triggers",
      featurePrefix: true,
      check: (value) => isTriggerDefinition(value) || "must default-export trigger(...)",
      description: "Trigger files: each default-exports trigger({ source, handle }), named by its path without extension.",
    },
  },
  setup(ctx) {
    registered.sources = builtInSources();
    const declared = new Map<string, TriggerDefinition>();
    for (const [name, file] of ctx.folders.triggers ?? []) if (isTriggerDefinition(file)) declared.set(name, file);
    const queuesOn = ctx.config.features.some((feature) => feature.key === "queues");
    let repos: Repositories | undefined;
    const native: RunningTriggers = {
      triggers: declared,
      async emit(name, data, options: EmitTriggerOptions) {
        const definition = declared.get(name);
        if (!definition) throw new Error(`Unknown trigger ${name}`);
        const items = definition.batch && Array.isArray(data) ? data : [data];
        const events: TriggerEvent[] = items.map((item) => ({ id: randomUUID(), kind: definition.source.kind, type: "test", time: new Date(), data: item, attributes: { ...(options.attributes ?? {}) }, attempt: 1 }));
        const outcomes = await runTriggerEvents({ name, definition, events, repos: () => repos!, logger: ctx.logger, queues: queuesOn });
        const failed = outcomes.find((outcome) => outcome.status === "failed");
        const first = failed ?? outcomes[0]!;
        const emission: TriggerEmission = { status: overallStatus(outcomes), trigger: name, eventId: first.eventId, outcomes };
        if (first.error !== undefined) emission.error = first.error;
        if (first.reason !== undefined) emission.reason = first.reason;
        return emission;
      },
      async dispatch(platform, raw, options = {}) {
        // Sources are asked in registration order; the first that recognizes the event decodes it.
        const found = [...registered.sources.values()].find(({ source }) => source.recognize(platform, raw));
        if (!found) return undefined;
        const { source } = found;
        const events = await source.decode(raw);
        const only = options.triggers ? new Set(options.triggers) : undefined;
        const candidates = [...declared].filter(([name, definition]) => definition.source.kind === source.kind && (!only || only.has(name))).sort(([a], [b]) => a.localeCompare(b));
        const outcomes: TriggerOutcome[] = [];
        const matched = new Set<string>();
        for (const [name, definition] of candidates) {
          const mine = events.filter((event) => source.matches(definition.source as never, event));
          for (const event of mine) matched.add(event.id);
          if (mine.length === 0) continue;
          outcomes.push(...(await runTriggerEvents({ name, definition, events: mine, repos: () => repos!, logger: ctx.logger, queues: queuesOn, ...(options.deadline !== undefined ? { deadline: options.deadline } : {}) })));
        }
        // An event no trigger takes is completed, so a misrouted event is not redelivered forever.
        for (const event of events) {
          if (matched.has(event.id)) continue;
          safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "trigger.event.unmatched", kind: source.kind, eventId: event.id });
          outcomes.push({ eventId: event.id, trigger: "", status: "completed", reason: "unmatched" });
        }
        const dispatched: TriggerDispatch = { kind: source.kind, outcomes };
        if (source.result) dispatched.response = await source.result(outcomes, raw);
        else {
          const failed = outcomes.filter((outcome) => outcome.status === "failed");
          if (failed.length > 0) dispatched.error = new Error(`${failed.length} of ${events.length} ${source.kind} events failed: ${failed.map((outcome) => outcome.eventId).join(", ")}`);
        }
        return dispatched;
      },
    };
    // Sources pull events in each worker of a server target, unless poll is false.
    const polls = ctx.options.poll && targetPolls(ctx.config);
    const pollers: Poller[] = [];
    const stores: TriggerCheckpoints[] = [];
    const checkpointModel = ctx.models.find((model) => model.key === "TriggerCheckpoint" && model.system);
    const owner = `${hostname()}-${process.pid}-${ctx.worker.index}-${randomUUID().slice(0, 8)}`;
    const checkpointsOf = (name: string): (() => TriggerCheckpoints) => {
      let store: TriggerCheckpoints | undefined;
      return () => {
        if (!checkpointModel) throw new Error(MISSING_CHECKPOINTS);
        if (!store) stores.push((store = checkpointStore({ adapter: ctx.config.database, model: checkpointModel, trigger: name, owner, now: () => clocks.current.now(), parse: parseDuration })));
        return store;
      };
    };
    // Sources are registered during the setups of later features, so the kinds are checked once every setup ran.
    ctx.app.onStart((start) => {
      for (const [name, definition] of declared) {
        if (!registered.sources.has(definition.source.kind)) throw new Error(missingSource(name, definition.source.kind));
      }
      repos = start.repos;
      running.current = native;
      if (!polls) return;
      const backoff = { min: parseDuration(ctx.options.pollBackoff.min) ?? 1000, max: parseDuration(ctx.options.pollBackoff.max) ?? 30_000 };
      for (const [name, definition] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
        const source = registered.sources.get(definition.source.kind)!.source;
        if (typeof source.poll !== "function") continue;
        pollers.push(
          startPoller({
            name,
            definition,
            source,
            run: (events) => runTriggerEvents({ name, definition, events, repos: () => repos!, logger: ctx.logger, queues: queuesOn }),
            checkpoints: checkpointsOf(name),
            logger: ctx.logger,
            clock: clocks.current,
            backoff,
          }),
        );
      }
    });
    // The polls stop pulling as soon as the shutdown starts.
    ctx.app.onShutdown(() => {
      for (const poller of pollers) poller.stop();
    });
    ctx.app.onStop(async () => {
      for (const poller of pollers) poller.stop();
      // Running handlers finish within the jobs' grace, then the leases go back so another instance continues at once.
      const grace = Math.min(parseDuration(ctx.config.jobs.shutdownGrace) ?? 10_000, Math.floor((parseDuration(ctx.config.lifecycle.stopTimeout) ?? 10_000) * 0.9));
      await Promise.all(pollers.map((poller) => poller.drain(grace)));
      for (const store of stores.splice(0)) {
        try {
          await store.releaseAll();
        } catch (error) {
          safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "trigger.checkpoints.release.failed", error: { message: (error as Error)?.message ?? String(error) } });
        }
      }
      pollers.splice(0);
      if (running.current === native) running.current = undefined;
      registered.sources = new Map();
    });
  },
  api: (ctx): TriggersApi => ({
    source(kind, source) {
      const caller = ctx.currentFeature();
      if (!caller || caller === "triggers") throw new Error("source() is only available during the setup of another feature");
      const problem = sourceProblem(source);
      if (problem) throw new Error(`Invalid trigger source ${kind} registered by ${caller}: ${problem}`);
      const taken = registered.sources.get(kind);
      if (taken) throw new Error(duplicateSource(kind, taken.owner, caller));
      registered.sources.set(kind, { source: source as TriggerSource, owner: caller });
    },
    dispatch: (platform, raw, options) => dispatchPlatformEvent(platform, raw, options),
  }),
});

/** The running native; throws while it is not enabled. */
export function runningTriggers(): RunningTriggers {
  const current = running.current;
  if (!current) throw new Error(NOT_ENABLED);
  return current;
}

/** The built-in sources, by kind. */
const builtInSources = (): Map<string, { source: TriggerSource; owner: string }> => new Map([[TEST_SOURCE_KIND, { source: testTriggerSource as TriggerSource, owner: "triggers" }]]);

/**
 * The trigger sources a configuration provides, by kind, outside a running service: the built-in ones and those the
 * features listing `triggers` in `requires` or `after` register in their setups, which run and stop again. For builds
 * that read a source's `describe` hints.
 */
export async function triggerSources(config: ResolvedConfig): Promise<Map<string, TriggerSource>> {
  registered.sources = builtInSources();
  const stop = await setUpDependents(config, "triggers");
  try {
    return new Map([...registered.sources].map(([kind, { source }]) => [kind, source]));
  } finally {
    await stop();
    registered.sources = new Map();
  }
}

export default triggersFeature;
export { runTriggerEvents, triggerTimedOut } from "./run.ts";
export { dispatchPlatformEvent, overallStatus } from "./state.ts";
export { checkpointStore, MISSING_CHECKPOINTS, triggerCheckpointEntity } from "./checkpoints.ts";
export type { CheckpointStoreOptions, ClaimedPartition, TriggerCheckpoints } from "./checkpoints.ts";
export { startPoller } from "./poll.ts";
export type { Poller, PollAcknowledgments, PollerInput, TriggerPollContext } from "./poll.ts";
export type { DispatchOptions, EmitTriggerOptions, TriggerDispatch, TriggerEmission } from "./state.ts";
export { TEST_SOURCE_KIND, testDelivery, testSource, testTriggerSource } from "./test-source.ts";
export type { TestDelivery, TestEventInput, TestSourceRef } from "./test-source.ts";
export { isTriggerDefinition, trigger, TRIGGER_DEFAULTS } from "./trigger.ts";
export type { ResolvedTriggerOptions, TriggerContext, TriggerDataOf, TriggerDefinition, TriggerHandler, TriggerInput, TriggerName, TriggerNames, TriggerOptions } from "./trigger.ts";
export type { TriggerEvent, TriggerOutcome, TriggerSource, TriggerSourceHints, TriggerSourceRef, TriggerStatus } from "./source.ts";
