import { test } from "bun:test";
import type { TriggerPollContext } from "../features/triggers/poll.ts";
import type { TriggerEvent, TriggerOutcome, TriggerSource, TriggerSourceRef } from "../features/triggers/source.ts";
import { activeTimers } from "./secret-provider-contract.ts";

/** What a source's tests give the contract. */
export interface TriggerSourceFixtures {
  /** The platform the raw delivery comes from (default `lambda`). */
  platform?: string;
  /** A raw delivery of the source with at least one event, as the platform hands it over. */
  raw: unknown;
  /** The same delivery delivered again (default: `raw` again); its events must keep their ids. */
  redelivery?: unknown;
  /** A raw event of another source, which the source must not recognize (default `{ other: true }`). */
  foreign?: unknown;
  /** A reference every event of `raw` matches. */
  ref: TriggerSourceRef;
  /** A reference no event of `raw` matches, when the source can tell references apart. */
  otherRef?: TriggerSourceRef;
}

/** What `runTriggerSourceContract` takes besides the source factory. */
export interface TriggerSourceContractOptions {
  /** Shown in the test titles (default: the source's kind). */
  name?: string;
  fixtures: TriggerSourceFixtures | (() => TriggerSourceFixtures | Promise<TriggerSourceFixtures>);
}

type Create = () => TriggerSource<never> | Promise<TriggerSource<never>>;

/** One check of the contract. */
export interface TriggerSourceCheck {
  name: string;
  run(create: Create, fixtures: TriggerSourceFixtures): Promise<void>;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const decoded = async (source: TriggerSource<never>, raw: unknown): Promise<TriggerEvent[]> => {
  const events = await source.decode(raw);
  if (!Array.isArray(events) || events.length === 0) fail("decode returned no events for the raw fixture");
  return events;
};

/** Runs a source's poll with a fake context until its first emission, then aborts it; resolves what it emitted. */
async function pollOnce(source: TriggerSource<never>, ref: TriggerSourceRef): Promise<{ emitted: TriggerEvent[]; acked: string[]; nacked: string[] }> {
  const controller = new AbortController();
  const emitted: TriggerEvent[] = [];
  const acked: string[] = [];
  const nacked: string[] = [];
  const context: TriggerPollContext = {
    async emit(events, acknowledgments = {}) {
      emitted.push(...events);
      // The first event fails, the others complete, so both acknowledgments are exercised.
      const outcomes: TriggerOutcome[] = events.map((event, index) => ({ eventId: event.id, trigger: "contract", status: index === 0 && events.length > 1 ? "failed" : "completed" }));
      for (const outcome of outcomes) {
        if (outcome.status === "failed") {
          nacked.push(outcome.eventId);
          await acknowledgments.nack?.(outcome, { retryInMs: 1000 });
        } else {
          acked.push(outcome.eventId);
          await acknowledgments.ack?.(outcome);
        }
      }
      controller.abort();
      return outcomes;
    },
    signal: controller.signal,
    log: { info() {}, warn() {}, error() {} },
    get checkpoints(): never {
      return fail("the contract gives polls no checkpoints; test partitioned sources with checkpointStore") as never;
    },
  };
  const running = Promise.resolve(source.poll!(ref as never, context));
  const outcome = await Promise.race([running.then(() => "returned", (error: unknown) => error), Bun.sleep(5000).then(() => "pending")]);
  if (!controller.signal.aborted) controller.abort();
  if (outcome === "pending") fail("the poll neither emitted nor returned within 5 seconds");
  if (outcome instanceof Error) throw outcome;
  const stopped = await Promise.race([running.then(() => true, () => true), Bun.sleep(2000).then(() => false)]);
  if (!stopped) fail("the poll kept running 2 seconds after its signal aborted");
  return { emitted, acked, nacked };
}

/** Every check the contract runs, in order. */
export const TRIGGER_SOURCE_CHECKS: readonly TriggerSourceCheck[] = [
  {
    name: "recognizes its deliveries and ignores others",
    async run(create, fixtures) {
      const source = await create();
      const platform = fixtures.platform ?? "lambda";
      if (source.recognize(platform, fixtures.raw) !== true) fail("recognize returned false for the raw fixture");
      if (source.recognize(platform, fixtures.foreign ?? { other: true }) !== false) fail("recognize returned true for a delivery of another source");
    },
  },
  {
    name: "decodes events with the TriggerEvent shape",
    async run(create, fixtures) {
      const source = await create();
      for (const event of await decoded(source, fixtures.raw)) {
        if (typeof event.id !== "string" || event.id === "") fail("an event has no id");
        if (event.kind !== source.kind) fail(`an event has kind ${JSON.stringify(event.kind)}; expected ${JSON.stringify(source.kind)}`);
        if (typeof event.type !== "string" || event.type === "") fail(`event ${event.id} has no type`);
        if (!(event.time instanceof Date) || Number.isNaN(event.time.getTime())) fail(`event ${event.id} has no valid time`);
        if (typeof event.attributes !== "object" || event.attributes === null || Object.values(event.attributes).some((value) => typeof value !== "string")) fail(`event ${event.id} has attributes that are not text`);
        if (!Number.isInteger(event.attempt) || event.attempt < 1) fail(`event ${event.id} has attempt ${event.attempt}; expected an integer of at least 1`);
      }
    },
  },
  {
    name: "matches its reference",
    async run(create, fixtures) {
      const source = await create();
      const events = await decoded(source, fixtures.raw);
      for (const event of events) if (source.matches(fixtures.ref as never, event) !== true) fail(`event ${event.id} does not match the ref fixture`);
      if (fixtures.otherRef) for (const event of events) if (source.matches(fixtures.otherRef as never, event) !== false) fail(`event ${event.id} matches the otherRef fixture`);
    },
  },
  {
    name: "keeps event ids stable across redeliveries",
    async run(create, fixtures) {
      const source = await create();
      const first = (await decoded(source, fixtures.raw)).map((event) => event.id);
      const again = (await decoded(source, fixtures.redelivery ?? fixtures.raw)).map((event) => event.id);
      if (JSON.stringify(first) !== JSON.stringify(again)) fail(`the redelivered events have other ids (${again.join(", ")} instead of ${first.join(", ")})`);
    },
  },
  {
    name: "answers partial failures with only the failed events",
    async run(create, fixtures) {
      const source = await create();
      if (!source.result) return;
      const events = await decoded(source, fixtures.raw);
      const outcomes: TriggerOutcome[] = events.map((event, index) => ({ eventId: event.id, trigger: "contract", status: index === 0 ? "failed" : "completed", ...(index === 0 ? { error: new Error("contract failure") } : {}) }));
      const answer = await source.result(outcomes, fixtures.raw);
      let text: string;
      try {
        text = JSON.stringify(answer) ?? "";
      } catch {
        return fail("the result is not JSON-serializable");
      }
      if (!text.includes(events[0]!.id)) fail("the result does not name the failed event");
      for (const event of events.slice(1)) if (text.includes(JSON.stringify(event.id))) fail(`the result names the completed event ${event.id}`);
      if (text.includes("contract failure")) fail("the result holds the error message");
    },
  },
  {
    name: "polls with acknowledgments when it polls",
    async run(create, fixtures) {
      const source = await create();
      if (!source.poll) return;
      const { emitted } = await pollOnce(source, fixtures.ref);
      if (emitted.length === 0) fail("the poll emitted no events");
    },
  },
  {
    name: "leaves no timers after stop",
    async run(create, fixtures) {
      const left = await activeTimers(async () => {
        const source = await create();
        await decoded(source, fixtures.raw);
        if (source.poll) await pollOnce(source, fixtures.ref);
      });
      if (left > 0) fail(`${left} timer${left === 1 ? " is" : "s are"} still active after the poll stopped`);
    },
  },
];

const fixturesOf = async (options: TriggerSourceContractOptions) => (typeof options.fixtures === "function" ? await options.fixtures() : options.fixtures);

/** Runs every check and resolves the failures, one `{ check, message }` each; an empty list means the source passes. */
export async function checkTriggerSource(create: Create, options: TriggerSourceContractOptions): Promise<{ check: string; message: string }[]> {
  const failures: { check: string; message: string }[] = [];
  for (const check of TRIGGER_SOURCE_CHECKS) {
    try {
      await check.run(create, await fixturesOf(options));
    } catch (error) {
      failures.push({ check: check.name, message: (error as Error)?.message ?? String(error) });
    }
  }
  return failures;
}

/**
 * Registers one `bun:test` test per check of the trigger source contract: recognition, decoding into the
 * `TriggerEvent` shape, matching, stable ids across redeliveries, results naming only the failed events of a partial
 * failure, polling with fake acknowledgments when the source polls, and no timer left after stop.
 */
export function runTriggerSourceContract(create: Create, options: TriggerSourceContractOptions): void {
  for (const check of TRIGGER_SOURCE_CHECKS) {
    test(`${options.name ?? "trigger source"}: ${check.name}`, async () => {
      await check.run(create, await fixturesOf(options));
    });
  }
}
