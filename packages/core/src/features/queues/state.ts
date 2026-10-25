import type { QueueAddOptions, QueueAddResult } from "./queue.ts";

const STORE = Symbol.for("quickservice.queues.state");

/**
 * Process-wide state of the `queues` feature, by name. It lives on `globalThis`, so the native and a copy of it ejected
 * into a project share it, and the core's `queues` and `ctx.queue` of jobs reach whichever of them runs.
 */
export function sharedState<T>(name: string, init: () => T): T {
  const store = ((globalThis as unknown as Record<symbol, Record<string, unknown>>)[STORE] ??= {});
  return (store[name] ??= init()) as T;
}

/** Where an `add` call comes from. */
export interface AddSource {
  /** The id of the request that adds the message, when there is one. */
  requestId?: string;
}

/** The running native, as its setup installs it. */
export interface RunningQueues {
  add(name: string, payload: unknown, options: QueueAddOptions | undefined, source: AddSource): Promise<QueueAddResult>;
}

/** The running native of this process, or undefined while it is not enabled. */
export const running = sharedState("running", () => ({ current: undefined as RunningQueues | undefined }));

/** The error of every queue call while the native is not enabled. */
export const NOT_ENABLED = "queues is not enabled; add queues: {} to quickservice.config.ts";

/** The running native; throws while it is not enabled. */
export function runningQueues(): RunningQueues {
  const current = running.current;
  if (!current) throw new Error(NOT_ENABLED);
  return current;
}
