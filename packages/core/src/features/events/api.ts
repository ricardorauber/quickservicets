import type { AnyEvent, FeatureHook, OperationInfo } from "../public.ts";
import type { Events } from "./bus.ts";

/** The feature API of `events`, reached with `ctx.feature("events")` from a feature that lists `events` in `requires` or `after`. */
export interface EventsApi {
  /** Appends a `beforeEmit` hook after the config's; it may change an event or return null to drop it. */
  addHook(name: "beforeEmit", fn: FeatureHook<AnyEvent | null, { operation: OperationInfo | undefined }>): void;
  /** Appends an `afterEmit` hook after the config's; it observes each event once stored and handed to dispatch. */
  addHook(name: "afterEmit", fn: FeatureHook<AnyEvent, undefined>): void;
  /** Registers a listener for a pattern; see `events.on`. */
  on: Events["on"];
  /** Publishes a custom event; see `events.emit`. */
  emit: Events["emit"];
  /** Registers a durable consumer of the outbox; see `events.deliver`. */
  deliver: Events["deliver"];
}
