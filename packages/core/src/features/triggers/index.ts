import { randomUUID } from "node:crypto";
import { defineFeature, type Repositories } from "../public.ts";
import { runTriggerEvents } from "./run.ts";
import type { TriggerEvent, TriggerSource } from "./source.ts";
import { NOT_ENABLED, overallStatus, running, sharedState, type EmitTriggerOptions, type RunningTriggers, type TriggerEmission } from "./state.ts";
import { TEST_SOURCE_KIND, testTriggerSource } from "./test-source.ts";
import { isTriggerDefinition, type TriggerDefinition } from "./trigger.ts";

/** The public API of the `triggers` native, `ctx.feature("triggers")` in a feature that lists it in `requires`, `after` or `enables`. */
export interface TriggersApi {
  /**
   * Registers the source of a kind, so triggers whose reference names that kind run on its events. Only available
   * during the setup of another feature; a kind registered twice fails startup naming both owners.
   */
  source(kind: string, source: TriggerSource<never>): void;
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
    registered.sources = new Map([[TEST_SOURCE_KIND, { source: testTriggerSource as TriggerSource, owner: "triggers" }]]);
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
  }),
});

/** The running native; throws while it is not enabled. */
export function runningTriggers(): RunningTriggers {
  const current = running.current;
  if (!current) throw new Error(NOT_ENABLED);
  return current;
}

export default triggersFeature;
export { runTriggerEvents, triggerTimedOut } from "./run.ts";
export { overallStatus } from "./state.ts";
export type { EmitTriggerOptions, TriggerEmission } from "./state.ts";
export { TEST_SOURCE_KIND, testDelivery, testSource, testTriggerSource } from "./test-source.ts";
export type { TestDelivery, TestEventInput, TestSourceRef } from "./test-source.ts";
export { isTriggerDefinition, trigger, TRIGGER_DEFAULTS } from "./trigger.ts";
export type { ResolvedTriggerOptions, TriggerContext, TriggerDataOf, TriggerDefinition, TriggerHandler, TriggerInput, TriggerName, TriggerNames, TriggerOptions } from "./trigger.ts";
export type { TriggerEvent, TriggerOutcome, TriggerSource, TriggerSourceHints, TriggerSourceRef, TriggerStatus } from "./source.ts";
