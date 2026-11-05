import { createHash } from "node:crypto";
import type { TriggerEvent, TriggerOutcome, TriggerSource, TriggerSourceRef } from "./source.ts";

/** The kind of the built-in test source. */
export const TEST_SOURCE_KIND = "test";

/** A reference to the built-in `test` source: every test event, or only those of one `type`. */
export interface TestSourceRef extends TriggerSourceRef {
  kind: "test";
  /** Only events of this type (default: every test event). */
  type?: string;
}

/** One event of a raw test delivery. */
export interface TestEventInput {
  /** The event id (default: a hash of the event, stable across redeliveries). */
  id?: string;
  /** The event type (default `test`). */
  type?: string;
  subject?: string;
  data?: unknown;
  attributes?: Record<string, string>;
  /** The delivery attempt (default 1). */
  attempt?: number;
  /** The event time, ISO 8601 (default: now). */
  time?: string;
}

/**
 * A raw delivery of the `test` source, as a platform would hand it to the service:
 * `{ quickservicets: { source: "test", events: [...] } }`.
 */
export interface TestDelivery {
  quickservicets: { source: "test"; events: TestEventInput[] };
}

/** A reference to the built-in `test` source, for triggers run by `emitTrigger` and by test deliveries. */
export function testSource(options: { type?: string } = {}): TestSourceRef {
  return { kind: TEST_SOURCE_KIND, ...(options.type !== undefined ? { type: options.type } : {}) };
}

/** A raw test delivery of the given events, for platform entries such as the lambda bootstrap. */
export function testDelivery(events: readonly TestEventInput[]): TestDelivery {
  return { quickservicets: { source: TEST_SOURCE_KIND, events: [...events] } };
}

const eventsOf = (raw: unknown): TestEventInput[] | undefined => {
  const body = (raw as { quickservicets?: { source?: unknown; events?: unknown } } | null)?.quickservicets;
  return body?.source === TEST_SOURCE_KIND && Array.isArray(body.events) ? (body.events as TestEventInput[]) : undefined;
};

/** A stable id for an event given without one: the hash of its content and position. */
const stableId = (input: TestEventInput, index: number) => createHash("sha256").update(`${index}:${JSON.stringify(input)}`).digest("hex").slice(0, 32);

/**
 * The built-in `test` source: recognizes test deliveries on every platform, decodes their events, matches a reference
 * by `type`, and answers a delivery with the failed events as `{ batchItemFailures: [{ itemIdentifier }] }`, the
 * partial batch response of queue platforms.
 */
export const testTriggerSource: TriggerSource<TestSourceRef> = {
  kind: TEST_SOURCE_KIND,
  recognize: (_platform, raw) => eventsOf(raw) !== undefined,
  decode(raw) {
    return (eventsOf(raw) ?? []).map(
      (input, index): TriggerEvent => ({
        id: input.id ?? stableId(input, index),
        kind: TEST_SOURCE_KIND,
        type: input.type ?? "test",
        time: input.time ? new Date(input.time) : new Date(),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        data: input.data,
        attributes: { ...(input.attributes ?? {}) },
        attempt: input.attempt ?? 1,
      }),
    );
  },
  matches: (ref, event) => ref.type === undefined || event.type === ref.type,
  result: (outcomes: readonly TriggerOutcome[]) => ({ batchItemFailures: [...new Set(outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.eventId))].map((itemIdentifier) => ({ itemIdentifier })) }),
};
