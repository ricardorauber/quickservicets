import type { TriggerOutcome, TriggerStatus } from "./source.ts";
import type { TriggerDefinition } from "./trigger.ts";

const STORE = Symbol.for("quickservicets.triggers.state");

/**
 * Process-wide state of the `triggers` feature, by name. It lives on `globalThis`, so the native and a copy of it
 * ejected into a project share it, and `emitTrigger` and the platform entries reach whichever of them runs.
 */
export function sharedState<T>(name: string, init: () => T): T {
  const store = ((globalThis as unknown as Record<symbol, Record<string, unknown>>)[STORE] ??= {});
  return (store[name] ??= init()) as T;
}

/** What `emitTrigger` takes besides the trigger and the data. */
export interface EmitTriggerOptions {
  /** The events' attributes. */
  attributes?: Record<string, string>;
}

/** What one emission resolves: the overall status (failed when any event failed), the first event and every outcome. */
export interface TriggerEmission {
  status: TriggerStatus;
  trigger: string;
  eventId: string;
  error?: unknown;
  reason?: string;
  outcomes: TriggerOutcome[];
}

/** What `dispatch` takes besides the platform and the raw event. */
export interface DispatchOptions {
  /** The platform's deadline, in epoch milliseconds; handlers stop 500 ms before it. */
  deadline?: number;
  /** Only these triggers receive the events, like the one trigger an Azure function is bound to. */
  triggers?: readonly string[];
}

/** What a dispatch resolves: the kind that decoded the event, every outcome, and the platform's answer or failure. */
export interface TriggerDispatch {
  kind: string;
  outcomes: TriggerOutcome[];
  /** The answer built by the source's `result`, when it has one. */
  response?: unknown;
  /** The failure of the invocation: set when an event failed and the source has no `result`. */
  error?: Error;
}

/** The running native, as its start installs it. */
export interface RunningTriggers {
  /** The triggers of the project, by name. */
  readonly triggers: ReadonlyMap<string, TriggerDefinition>;
  /** Runs a trigger with events made from `data`, as a delivery would. */
  emit(name: string, data: unknown, options: EmitTriggerOptions): Promise<TriggerEmission>;
  /** Hands a raw platform event to the triggers it belongs to; undefined when no source recognizes it. */
  dispatch(platform: string, raw: unknown, options?: DispatchOptions): Promise<TriggerDispatch | undefined>;
}

/** The running native of this process, or undefined while it is not enabled or not started. */
export const running = sharedState("running", () => ({ current: undefined as RunningTriggers | undefined }));

/** The error of `emitTrigger` while the native is not running. */
export const NOT_ENABLED = "triggers is not enabled; add triggers: {} to quickservicets.config.ts";

/** The overall status of outcomes: failed when one failed, discarded when every one was, completed otherwise. */
export function overallStatus(outcomes: readonly TriggerOutcome[]): TriggerStatus {
  if (outcomes.some((outcome) => outcome.status === "failed")) return "failed";
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.status === "discarded")) return "discarded";
  return "completed";
}

/**
 * Hands a raw platform event to the running native's triggers, for the platform entries: undefined while the native
 * does not run or when no source recognizes the event.
 */
export function dispatchPlatformEvent(platform: string, raw: unknown, options: DispatchOptions = {}): Promise<TriggerDispatch | undefined> {
  return running.current ? running.current.dispatch(platform, raw, options) : Promise.resolve(undefined);
}
