/** One event a trigger handles, decoded by its source. */
export interface TriggerEvent<Data = unknown> {
  /** Stable across redeliveries of the same event, so handlers can skip an event they already handled. */
  id: string;
  /** The kind of the source that decoded it, like `test` or `cloudevents`. */
  kind: string;
  /** The event's type, like `google.cloud.storage.object.v1.finalized`. */
  type: string;
  time: Date;
  /** What the event is about, like an object key. */
  subject?: string;
  /** The decoded payload. */
  data: Data;
  /** The source's metadata, as text values. */
  attributes: Record<string, string>;
  /** The delivery attempt, starting at 1. */
  attempt: number;
}

/** A trigger's source reference: an object made by a source factory, like `testSource()`, naming the source kind. */
export interface TriggerSourceRef {
  kind: string;
  [option: string]: unknown;
}

/** How one event ended. */
export type TriggerStatus = "completed" | "failed" | "discarded";

/** The outcome of one event of a trigger. */
export interface TriggerOutcome {
  eventId: string;
  trigger: string;
  status: TriggerStatus;
  error?: unknown;
  /** Why the event was discarded. */
  reason?: string;
}

/** Hints a source gives infrastructure generators about the platform resources a trigger needs. */
export interface TriggerSourceHints {
  /** The binding of an Azure Functions trigger, written into the trigger's `function.json`. */
  azure?: Record<string, unknown>;
  [platform: string]: unknown;
}

/**
 * A source of trigger events: it recognizes the raw events of a platform that belong to it, decodes them into
 * `TriggerEvent`s and tells which triggers an event belongs to. Features register sources with
 * `ctx.feature("triggers").source(kind, source)`.
 */
export interface TriggerSource<Ref extends TriggerSourceRef = TriggerSourceRef> {
  /** The kind trigger references name, like `s3` or `cloudevents`. */
  kind: string;
  /** Whether a raw platform event (`platform` is `lambda`, `azure-functions` or another target) belongs to this source. */
  recognize(platform: string, raw: unknown): boolean;
  /** The events of a raw platform event. */
  decode(raw: unknown): TriggerEvent[] | Promise<TriggerEvent[]>;
  /** Whether an event belongs to a trigger's reference, like the bucket and prefix of an `s3` reference. */
  matches(ref: Ref, event: TriggerEvent): boolean;
  /** Pulls events in server targets. */
  poll?(ref: Ref, ctx: unknown): void | Promise<void>;
  /** The platform answer for the outcomes of one raw event, like a partial batch response. */
  result?(outcomes: readonly TriggerOutcome[], raw: unknown): unknown;
  /** An HTTP route receiving pushed events. */
  push?: unknown;
  /** Platform resource hints for infrastructure generators. */
  describe?(ref: Ref): TriggerSourceHints;
}
