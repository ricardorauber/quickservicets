import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { type FeatureHook, hook, integer, list, provider, record, secretEnvironment, http, reportError, boolean, defineFeature, type FeatureSetupContext, type ServiceRequest, type RunTenant, duration, isFunctionTarget, object, parseDuration, safeLog, setUpDependents, systemClock, type JobClock, type Repositories, type ResolvedConfig } from "../public.ts";
import { checkPushAuth, CLOUDEVENTS_KIND, cloudEventsSource, GOOGLE_ISSUER, pushPath, requestEvents, type CloudEventsRef, type KeyLoader, type SigningKey } from "./cloudevents.ts";
import { checkpointStore, MISSING_CHECKPOINTS, type TriggerCheckpoints } from "./checkpoints.ts";
import { startPoller, type Poller } from "./poll.ts";
import { runTriggerEvents, type AfterHandle, type BeforeHandle, type TriggerFailed, type TriggerRunHooks } from "./run.ts";
import type { TriggerEvent, TriggerOutcome, TriggerSource } from "./source.ts";
import { dispatchPlatformEvent, NOT_ENABLED, overallStatus, running, sharedState, type DispatchOptions, type EmitTriggerOptions, type RunningTriggers, type TriggerDispatch, type TriggerEmission } from "./state.ts";
import { TEST_SOURCE_KIND, testTriggerSource } from "./test-source.ts";
import { isTriggerDefinition, type ResolvedTriggerOptions, type TriggerDefinition } from "./trigger.ts";

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
  /** Adds a hook after the ones written in the config. */
  addHook(name: "beforeHandle", fn: FeatureHook<BeforeHandle, undefined>): void;
  addHook(name: "afterHandle", fn: FeatureHook<AfterHandle, undefined>): void;
  addHook(name: "onFailed", fn: FeatureHook<TriggerFailed, undefined>): void;
}

/** The sources registered in this process, by kind, with the feature that registered each. */
const registered = sharedState("sources", () => ({ sources: new Map<string, { source: TriggerSource; owner: string }>() }));

/** The clock pollers schedule their restarts with; tests set a fake one. */
const clocks = sharedState("clock", () => ({ current: systemClock as JobClock, random: Math.random as () => number }));

/** Sets the clock of the pollers' restart delays (default: the system clock) and the random numbers of the retry jitter, for tests. */
export function setTriggersClock(clock: JobClock = systemClock, random: () => number = Math.random): void {
  clocks.current = clock;
  clocks.random = random;
}

/** What the `trigger.event.failed` and `trigger.event.dead` events carry: never the event's data. */
export interface TriggerFailureEvent {
  trigger: string;
  kind: string;
  eventId: string;
  attempt: number;
  error: { message: string };
}

/** The options one trigger's override may set. */
const overrideShape = {
  concurrency: integer().min(1).optional().describe("How many events of the trigger run at once in one process."),
  timeout: duration().optional().describe("The longest one event (or batch) of the trigger may run."),
  retries: integer().min(0).optional().describe("How many times a failed event of the trigger is retried in polling mode."),
  retryDelay: duration().optional().describe("The delay before the first retry of the trigger, doubled for each next one."),
  enabled: boolean().optional().describe("false turns the trigger off: no route, poll or dispatch reaches it."),
};

const options = object({
  overrides: record(object(overrideShape))
    .keys(/^[a-z0-9][a-z0-9_/-]*$/i, "a trigger name is a path of triggers/ without extension, like uploads/new-image")
    .describe("Options of single triggers by name, over the trigger file's options; QS_TRIGGERS_OVERRIDES_<NAME>_<OPTION> wins over them."),
  beforeHandle: hook<BeforeHandle, undefined>().describe("Runs before each event's handler with the trigger and the event; returns a changed event, or null to discard it, and a throw fails the event."),
  afterHandle: hook<AfterHandle, undefined>().describe("Runs after each event with the trigger, the event, its status and durationMs."),
  onFailed: hook<TriggerFailed, undefined>().describe("Runs after each failed event with the trigger, the event, the error and final, true on its last attempt."),
  sources: list(provider<TriggerSource>("TriggerSource", ["recognize", "decode", "matches"]))
    .default([])
    .describe("Sources of the project, each registered under its kind like those features register."),
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

/** The per-trigger options a variable sets, with the parser of its text. */
const OVERRIDE_VARIABLES = [
  ["CONCURRENCY", "concurrency", (text: string) => (/^[1-9]\d*$/.test(text) ? Number(text) : undefined), "an integer of at least 1"],
  ["TIMEOUT", "timeout", (text: string) => (parseDuration(text) !== undefined ? text : undefined), "a duration like 30s"],
  ["RETRIES", "retries", (text: string) => (/^\d+$/.test(text) ? Number(text) : undefined), "an integer of at least 0"],
  ["RETRY_DELAY", "retryDelay", (text: string) => (parseDuration(text) !== undefined ? text : undefined), "a duration like 10s"],
  ["ENABLED", "enabled", (text: string) => (text === "true" ? true : text === "false" ? false : undefined), "true or false"],
] as const;

/** A trigger name as its variables write it: upper snake case, with `/` and `-` as `_`. */
export const triggerVariableName = (name: string) => name.replace(/[/-]/g, "_").toUpperCase();

/** The variables that override one trigger's options, like `QS_TRIGGERS_OVERRIDES_UPLOADS_NEW_IMAGE_CONCURRENCY`. */
export const TRIGGER_OVERRIDE_VARIABLE = /^QS_TRIGGERS_OVERRIDES_[A-Z0-9_]+_(CONCURRENCY|TIMEOUT|RETRIES|RETRY_DELAY|ENABLED)$/;

/**
 * A trigger's options in effect: its variables (`QS_TRIGGERS_OVERRIDES_<NAME>_<OPTION>`) over `overrides.<name>` over
 * the file's options over the defaults; throws for a variable whose text is not valid.
 */
export function effectiveOptions(name: string, file: ResolvedTriggerOptions, override: Partial<ResolvedTriggerOptions> & { enabled?: boolean } = {}, env: Record<string, string | undefined> = {}): ResolvedTriggerOptions & { enabled: boolean } {
  const fromEnv: Record<string, unknown> = {};
  for (const [suffix, key, parse, expected] of OVERRIDE_VARIABLES) {
    const variable = `QS_TRIGGERS_OVERRIDES_${triggerVariableName(name)}_${suffix}`;
    const text = env[variable];
    if (text === undefined || text === "") continue;
    const value = parse(text);
    if (value === undefined) throw new Error(`Invalid ${variable}: expected ${expected}`);
    fromEnv[key] = value;
  }
  const defined = Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined));
  const merged = { ...file, ...defined, ...fromEnv } as ResolvedTriggerOptions & { enabled?: boolean };
  return { ...merged, enabled: merged.enabled !== false };
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
        title: "CloudEvents",
        text: [
          "`cloudEvents({ type?, source?, path?, auth? })` is the built-in kind `cloudevents`: `type` and `source` match exactly or by a prefix ending in `*`, and each trigger on it gets the runtime route `POST <path>` (default `/_triggers/<trigger name>`). The route takes binary mode (`ce-id`, `ce-type`, `ce-source`, `ce-specversion: 1.0`, optional `ce-time` and `ce-subject`, the data as the body), structured mode (`application/cloudevents+json`) and batch mode (`application/cloudevents-batch+json`); JSON data is parsed and other data stays bytes. A missing attribute answers 400 `VALIDATION_ERROR` `Invalid CloudEvent: <reason>`.",
          "",
          "`auth: { bearer }` compares a shared token (text or a secret reference) in constant time; `auth: { oidc: { audience, issuer?, email? } }` checks a JWT signed by the issuer's keys (default `https://accounts.google.com`, fetched through the native's HTTP service `triggers/oidc` and kept for an hour) for `aud`, `iss`, `exp` and the optional service account `email`. A failed check answers 401 `INVALID_SIGNATURE` `Invalid event credentials` without running the trigger. `OPTIONS <path>` with `WebHook-Request-Origin` answers 200 with `WebHook-Allowed-Origin` and `WebHook-Allowed-Rate: *`, the Event Grid handshake.",
          "",
          "The route answers 204 when every event completed or was discarded, and 500 without details when one failed, so the sender retries. Push routes are exempt from the CSRF item and, unless the trigger sets `tenant: true`, from tenancy resolution; they keep the global rate limit and are left out of `/openapi.json`.",
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
        title: "Failures, retries and batches",
        text: [
          "A handler that throws `new TriggerDiscard(reason)` ends the event `discarded`: acknowledged without a retry and logged with the reason. Any other error ends it `failed`.",
          "",
          "In function targets a failed event goes back to the platform through the source's `result`, so the platform's own retry policy applies, and `event.attempt` is the platform's delivery count when the source knows it. In polling mode a failed event is `nack`ed with `retryInMs` = `retryDelay × 2^(attempt − 1)`, at most 1 hour with ±10% jitter, up to the trigger's `retries`; after the last attempt the source dead-letters it through `deadLetter` when it has one (otherwise it is acknowledged) and the native logs `trigger.event.dead` at error level.",
          "",
          "A source with `ordered: true` (stream partitions, FIFO queues) hands batches in order: the events of one partition (`attributes.partition`) run one after the other, and the first failure fails it and every later event of the partition without running them; in unordered batches only the failed events are reported.",
          "",
          "While `errors` is enabled, a dead event, and a failed event on the platform's last attempt (when the source's `lastAttempt(event)` says so), calls `reportError` with the tags `trigger`, `kind`, `eventId` and `attempt`, never the event's data. While `events` is enabled, the native emits `trigger.event.failed` for every failed attempt and `trigger.event.dead` for a dead event, with `{ trigger, kind, eventId, attempt, error }`.",
        ].join("\n"),
      },
      {
        title: "Per-trigger options",
        text: [
          "A trigger's options come, from highest to lowest, from `QS_TRIGGERS_OVERRIDES_<NAME>_CONCURRENCY`, `_TIMEOUT`, `_RETRIES`, `_RETRY_DELAY` and `_ENABLED` (the name in upper snake case, `/` and `-` as `_`: `uploads/new-image` is `UPLOADS_NEW_IMAGE`), `triggers.overrides.<name>`, the trigger file's `options`, and the defaults (`concurrency` 1, `timeout` `30s`, `retries` 3, `retryDelay` `10s`). `enabled: false` turns one trigger off. An override naming no trigger adds `triggers.overrides.<name> matches no trigger` to the config warnings.",
          "",
          "A trigger's `options.when(event)` decides per event, before `handle`, whether it is handled; `false` discards it with the reason `when`.",
        ].join("\n"),
      },
      {
        title: "Hooks",
        text: [
          "`beforeHandle` receives `{ trigger, event }` before each event's handler and may return a changed event, or `null` to discard it (reason `beforeHandle`); a throw fails the event. `afterHandle` receives `{ trigger, event, status, durationMs }` after each event, and `onFailed` `{ trigger, event, error, final }` after each failed one, `final` true on its last attempt. Both are after-hooks: a failing one is logged as `feature.hook.failed`. A feature adds hooks with `ctx.feature(\"triggers\").addHook(name, fn)`.",
          "",
          "```ts",
          "triggers: {",
          "  onFailed: ({ trigger, event, final }) => final && console.error(`${trigger} gave up on ${event.id}`),",
          "},",
          "```",
        ].join("\n"),
      },
      {
        title: "Built-in kinds and project sources",
        text: [
          "| Kind | Factory | What it does |",
          "| --- | --- | --- |",
          "| `test` | `testSource({ type? })` | Test deliveries `{ quickservicets: { source: \"test\", events } }` and `emitTrigger`, answered with `{ batchItemFailures }` |",
          "| `cloudevents` | `cloudEvents({ type?, source?, path?, auth? })` | CloudEvents pushed to `POST /_triggers/<name>` |",
          "",
          "`sources` registers project sources (objects with `kind`, `recognize`, `decode` and `matches`) like features do. `runTriggerSourceContract(create, { fixtures })` of `@quickservicets/core/testing` registers one `bun:test` test per check of the contract: recognition, decoding into the `TriggerEvent` shape, matching, stable ids across redeliveries, results naming only the failed events of a partial failure, polling with fake acknowledgments when the source polls, and no timer left after stop; the built-in `test` and `cloudevents` sources pass it. `quickservicets eject triggers` copies the native into `features/triggers/`.",
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
  variablePatterns: [TRIGGER_OVERRIDE_VARIABLE],
  // Push routes are exempted from CSRF, tenancy and OpenAPI, and OIDC keys are fetched through an HTTP service.
  after: ["http", "security", "tenancy"],
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
    for (const source of ctx.options.sources as TriggerSource[]) {
      const taken = registered.sources.get(source.kind);
      if (taken) throw new Error(duplicateSource(source.kind, taken.owner, "triggers.sources"));
      registered.sources.set(source.kind, { source, owner: "triggers.sources" });
    }
    // Each trigger runs with its options in effect; one turned off by its override is left out entirely.
    const env = secretEnvironment();
    const overrides = ctx.options.overrides as Record<string, Partial<ResolvedTriggerOptions> & { enabled?: boolean }>;
    const declared = new Map<string, TriggerDefinition>();
    for (const [name, file] of ctx.folders.triggers ?? []) {
      if (!isTriggerDefinition(file)) continue;
      const { enabled, ...effective } = effectiveOptions(name, file.options, overrides[name], env);
      if (enabled) declared.set(name, { ...file, options: effective });
    }
    const names = new Set([...(ctx.folders.triggers ?? new Map()).keys()]);
    for (const name of Object.keys(overrides)) {
      if (names.has(name)) continue;
      const warning = `triggers.overrides.${name} matches no trigger`;
      if (ctx.config.warnings.includes(warning)) continue;
      ctx.config.warnings.push(warning);
      safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "config.warning", warning });
    }
    const hooks: TriggerRunHooks = { beforeHandle: ctx.options.beforeHandle as never, afterHandle: ctx.options.afterHandle as never, onFailed: ctx.options.onFailed as never };
    registerPushRoutes(ctx, declared, (input) => runPushed(input));
    const queuesOn = ctx.config.features.some((feature) => feature.key === "queues");
    /** Whether a failed pushed event was its last attempt: the source's word when it knows, else its attempt past the retries. */
    const finalOf = (source: TriggerSource | undefined) => (source?.lastAttempt ? (event: TriggerEvent) => source.lastAttempt!(event) : undefined);
    const eventsOn = ctx.config.features.some((feature) => feature.key === "events");
    const failureOf = (outcome: TriggerOutcome, event: TriggerEvent): TriggerFailureEvent => ({ trigger: outcome.trigger, kind: event.kind, eventId: event.id, attempt: event.attempt, error: { message: (outcome.error as Error)?.message ?? String(outcome.error) } });
    const emitEvent = async (type: "trigger.event.failed" | "trigger.event.dead", payload: TriggerFailureEvent) => {
      if (!eventsOn) return;
      try {
        await ctx.events.emit(type as never, payload as never);
      } catch (error) {
        safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "trigger.event.emit.failed", type, error: { message: (error as Error)?.message ?? String(error) } });
      }
    };
    // Reports carry the trigger, the kind, the event id and the attempt, never the event's data.
    const report = (outcome: TriggerOutcome, event: TriggerEvent) =>
      reportError(outcome.error, { tags: { trigger: outcome.trigger, kind: event.kind, eventId: event.id, attempt: String(event.attempt) } });
    /** What follows the outcomes of a delivery the platform pushed: events for failures, a report on the last attempt. */
    const afterPushed = async (outcomes: readonly TriggerOutcome[], events: readonly TriggerEvent[], source: TriggerSource | undefined) => {
      const byId = new Map(events.map((event) => [event.id, event]));
      for (const outcome of outcomes) {
        const event = byId.get(outcome.eventId);
        if (outcome.status !== "failed" || !event) continue;
        if (source?.lastAttempt?.(event) === true) report(outcome, event);
        await emitEvent("trigger.event.failed", failureOf(outcome, event));
      }
    };
    /** Runs one trigger on the events of a push request, as dispatch would. */
    async function runPushed({ name, definition, events, tenant }: { name: string; definition: TriggerDefinition; events: TriggerEvent[]; tenant?: RunTenant }): Promise<TriggerOutcome[]> {
      const source = registered.sources.get(definition.source.kind)!.source;
      const mine = events.filter((event) => source.matches(definition.source as never, event));
      const outcomes = mine.length > 0 ? await runTriggerEvents({ name, definition, events: mine, repos: () => repos!, logger: ctx.logger, queues: queuesOn, ordered: source.ordered === true, hooks, isFinal: finalOf(source), ...(tenant ? { tenant } : {}) }) : [];
      for (const event of events) {
        if (mine.includes(event)) continue;
        safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "trigger.event.unmatched", kind: source.kind, eventId: event.id });
        outcomes.push({ eventId: event.id, trigger: "", status: "completed", reason: "unmatched" });
      }
      await afterPushed(outcomes, events, source);
      return outcomes;
    }
    /** What follows an event that failed its last polled attempt. */
    const onDead = async (outcome: TriggerOutcome, event: TriggerEvent) => {
      const failure = failureOf(outcome, event);
      safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "trigger.event.dead", trigger: outcome.trigger, kind: event.kind, eventId: event.id, attempt: event.attempt, error: failure.error });
      report(outcome, event);
      await emitEvent("trigger.event.dead", failure);
    };
    let repos: Repositories | undefined;
    const native: RunningTriggers = {
      triggers: declared,
      async emit(name, data, options: EmitTriggerOptions) {
        const definition = declared.get(name);
        if (!definition) throw new Error(`Unknown trigger ${name}`);
        const items = definition.batch && Array.isArray(data) ? data : [data];
        const events: TriggerEvent[] = items.map((item) => ({ id: randomUUID(), kind: definition.source.kind, type: "test", time: new Date(), data: item, attributes: { ...(options.attributes ?? {}) }, attempt: 1 }));
        const source = registered.sources.get(definition.source.kind)?.source;
        const outcomes = await runTriggerEvents({ name, definition, events, repos: () => repos!, logger: ctx.logger, queues: queuesOn, ordered: source?.ordered === true, hooks, isFinal: finalOf(source) });
        await afterPushed(outcomes, events, source);
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
          outcomes.push(...(await runTriggerEvents({ name, definition, events: mine, repos: () => repos!, logger: ctx.logger, queues: queuesOn, ordered: source.ordered === true, hooks, isFinal: finalOf(source), ...(options.deadline !== undefined ? { deadline: options.deadline } : {}) })));
        }
        // An event no trigger takes is completed, so a misrouted event is not redelivered forever.
        for (const event of events) {
          if (matched.has(event.id)) continue;
          safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "trigger.event.unmatched", kind: source.kind, eventId: event.id });
          outcomes.push({ eventId: event.id, trigger: "", status: "completed", reason: "unmatched" });
        }
        await afterPushed(outcomes, events, source);
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
            run: async (events) => {
              const outcomes = await runTriggerEvents({ name, definition, events, repos: () => repos!, logger: ctx.logger, queues: queuesOn, ordered: source.ordered === true, hooks });
              // Failed events are announced on every attempt; the last attempt goes to onDead.
              const byId = new Map(events.map((event) => [event.id, event]));
              for (const outcome of outcomes) if (outcome.status === "failed" && byId.has(outcome.eventId)) await emitEvent("trigger.event.failed", failureOf(outcome, byId.get(outcome.eventId)!));
              return outcomes;
            },
            onDead,
            random: () => clocks.random(),
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
    addHook: ctx.addHook as TriggersApi["addHook"],
  }),
});

/** The running native; throws while it is not enabled. */
export function runningTriggers(): RunningTriggers {
  const current = running.current;
  if (!current) throw new Error(NOT_ENABLED);
  return current;
}

/**
 * Registers the push routes of the triggers on the built-in CloudEvents source: `POST <path>` runs the trigger and
 * answers 204, or 500 without details when an event failed; `OPTIONS <path>` completes the Event Grid handshake. The
 * routes are exempt from CSRF and, unless the trigger sets `tenant`, from tenancy, and stay out of the OpenAPI document.
 */
function registerPushRoutes(
  ctx: FeatureSetupContext,
  declared: ReadonlyMap<string, TriggerDefinition>,
  run: (input: { name: string; definition: TriggerDefinition; events: TriggerEvent[]; tenant?: RunTenant }) => Promise<TriggerOutcome[]>,
): void {
  const pushed = [...declared].filter(([, definition]) => definition.source.kind === CLOUDEVENTS_KIND) as [string, TriggerDefinition][];
  if (pushed.length === 0) return;
  const keys = oidcKeys(ctx, pushed.map(([, definition]) => definition.source as CloudEventsRef));
  const tenancy = ctx.config.features.some((feature) => feature.key === "tenancy");
  const paths = new Map<string, string>();
  for (const [name, definition] of pushed) {
    const ref = definition.source as CloudEventsRef;
    const path = pushPath(ref, name);
    const taken = paths.get(path);
    if (taken) throw new Error(`triggers/${name} and triggers/${taken} both push to ${path}; give one a path`);
    paths.set(path, name);
    if (tenancy && !definition.tenant) ctx.feature("tenancy").exempt(path);
    const options = { auth: false, tags: { csrf: { on: false, options: {} } } };
    ctx.app.route(
      "POST",
      path,
      async (_repos: unknown, req: ServiceRequest) => {
        await checkPushAuth(req.raw, ref.auth, keys);
        const events = await requestEvents(req.raw);
        const tenant = definition.tenant ? (req as { tenant?: RunTenant }).tenant : undefined;
        const outcomes = await run({ name, definition, events, ...(tenant ? { tenant } : {}) });
        // A failed event answers 500 so the sender retries; the answer never carries the error.
        return new Response(null, { status: outcomes.some((outcome) => outcome.status === "failed") ? 500 : 204 });
      },
      options,
    );
    ctx.app.route(
      "OPTIONS",
      path,
      (_repos: unknown, req: ServiceRequest) => {
        const origin = req.headers.get("webhook-request-origin");
        return new Response(null, { status: 200, headers: origin ? { "WebHook-Allowed-Origin": origin, "WebHook-Allowed-Rate": "*" } : {} });
      },
      options,
    );
  }
}

/**
 * The key loader of the OIDC issuers the push routes use: each issuer is an HTTP service of the native (`oidc`, then
 * `oidc-2`…), its discovery document gives the JWKS address, and its keys are kept for an hour.
 */
function oidcKeys(ctx: FeatureSetupContext, refs: readonly CloudEventsRef[]): KeyLoader {
  const issuers = [...new Set(refs.flatMap((ref) => (ref.auth && "oidc" in ref.auth ? [ref.auth.oidc.issuer ?? GOOGLE_ISSUER] : [])))];
  const services = new Map<string, string>();
  if (issuers.length > 0 && !ctx.config.features.some((feature) => feature.key === "http")) throw new Error("triggers needs the http native to verify OIDC push tokens; remove http: false");
  issuers.forEach((issuer, index) => {
    const name = index === 0 ? "oidc" : `oidc-${index + 1}`;
    ctx.feature("http").addService(name, { url: issuer });
    services.set(issuer, `triggers/${name}`);
  });
  const cache = new Map<string, { at: number; keys: Map<string, SigningKey> }>();
  return async (issuer, refresh = false) => {
    const cached = cache.get(issuer);
    if (cached && !refresh && Date.now() - cached.at < OIDC_KEYS_TTL_MS) return cached.keys;
    const service = services.get(issuer);
    if (!service) return new Map();
    const discovery = (await http.service(service as never).get("/.well-known/openid-configuration").send()) as { jwks_uri?: string };
    if (typeof discovery?.jwks_uri !== "string") throw new Error(`The OIDC issuer ${issuer} has no jwks_uri`);
    const document = (await http.get(discovery.jwks_uri).send()) as { keys?: SigningKey[] };
    const keys = new Map((document?.keys ?? []).filter((key) => typeof key.kid === "string").map((key) => [key.kid!, key]));
    cache.set(issuer, { at: Date.now(), keys });
    return keys;
  };
}

/** The built-in sources, by kind. */
const builtInSources = (): Map<string, { source: TriggerSource; owner: string }> =>
  new Map([
    [TEST_SOURCE_KIND, { source: testTriggerSource as TriggerSource, owner: "triggers" }],
    [CLOUDEVENTS_KIND, { source: cloudEventsSource as TriggerSource, owner: "triggers" }],
  ]);

/** How long the signing keys of an OIDC issuer are kept. */
export const OIDC_KEYS_TTL_MS = 3_600_000;

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
export { isTriggerDiscard, TriggerDiscard } from "./discard.ts";
export { CLOUDEVENTS_KIND, cloudEvents, cloudEventsSource, GOOGLE_ISSUER, invalidCloudEvent, invalidEventCredentials, matchesPattern, pushPath, requestEvents, structuredEvent, verifyOidcToken } from "./cloudevents.ts";
export type { CloudEventsAuth, CloudEventsOptions, CloudEventsRef, KeyLoader, SigningKey } from "./cloudevents.ts";
export { partitionOf, skippedAfterFailure } from "./run.ts";
export type { AfterHandle, BeforeHandle, TriggerFailed, TriggerRunHooks } from "./run.ts";
export { checkpointStore, MISSING_CHECKPOINTS, triggerCheckpointEntity } from "./checkpoints.ts";
export type { CheckpointStoreOptions, ClaimedPartition, TriggerCheckpoints } from "./checkpoints.ts";
export { MAX_RETRY_DELAY_MS, retryDelayMs, startPoller } from "./poll.ts";
export type { Poller, PollAcknowledgments, PollerInput, TriggerPollContext } from "./poll.ts";
export type { DispatchOptions, EmitTriggerOptions, TriggerDispatch, TriggerEmission } from "./state.ts";
export { TEST_SOURCE_KIND, testDelivery, testSource, testTriggerSource } from "./test-source.ts";
export type { TestDelivery, TestEventInput, TestSourceRef } from "./test-source.ts";
export { isTriggerDefinition, trigger, TRIGGER_DEFAULTS } from "./trigger.ts";
export type { ResolvedTriggerOptions, TriggerContext, TriggerDataOf, TriggerDefinition, TriggerHandler, TriggerInput, TriggerName, TriggerNames, TriggerOptions } from "./trigger.ts";
export type { TriggerEvent, TriggerOutcome, TriggerSource, TriggerSourceHints, TriggerSourceRef, TriggerStatus } from "./source.ts";
