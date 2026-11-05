import { randomUUID } from "node:crypto";
import { defineFeature, safeLog, setUpDependents, type Repositories, type ResolvedConfig } from "../public.ts";
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
        title: "Sources",
        text: [
          "A source is a `TriggerSource`: `kind`, `recognize(platform, raw)`, `decode(raw)` returning events and `matches(ref, event)`, plus the optional `poll(ref, ctx)`, `result(outcomes, raw)`, `push` and `describe(ref)`. A feature listing `triggers` in `requires`, `after` or `enables` registers one during its setup with `ctx.feature(\"triggers\").source(kind, source)`. A trigger on a kind no feature registers fails startup with `triggers/<name> uses source <kind>, which no feature registers; enable the feature that provides it`.",
          "",
          "The built-in kind `test` (`testSource({ type? })`) runs triggers in tests: `emitTrigger(name, data, { attributes? })` of `@quickservicets/core/testing` runs a trigger as a delivery would and resolves its outcome; for a trigger with `batch: true`, an array of data is one delivery of one event per item.",
        ].join("\n"),
      },
    ],
  },
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
    // Sources are registered during the setups of later features, so the kinds are checked once every setup ran.
    ctx.app.onStart((start) => {
      for (const [name, definition] of declared) {
        if (!registered.sources.has(definition.source.kind)) throw new Error(missingSource(name, definition.source.kind));
      }
      repos = start.repos;
      running.current = native;
    });
    ctx.app.onStop(() => {
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
export type { DispatchOptions, EmitTriggerOptions, TriggerDispatch, TriggerEmission } from "./state.ts";
export { TEST_SOURCE_KIND, testDelivery, testSource, testTriggerSource } from "./test-source.ts";
export type { TestDelivery, TestEventInput, TestSourceRef } from "./test-source.ts";
export { isTriggerDefinition, trigger, TRIGGER_DEFAULTS } from "./trigger.ts";
export type { ResolvedTriggerOptions, TriggerContext, TriggerDataOf, TriggerDefinition, TriggerHandler, TriggerInput, TriggerName, TriggerNames, TriggerOptions } from "./trigger.ts";
export type { TriggerEvent, TriggerOutcome, TriggerSource, TriggerSourceHints, TriggerSourceRef, TriggerStatus } from "./source.ts";
