import type { FeatureHook, ServiceRequest } from "../public.ts";
import type { QueueBroker, QueueReceivedMessage } from "./broker.ts";
import type { QueueAddOptions } from "./queue.ts";

/** What `beforeEnqueue` hooks receive and may return changed: an `add` call before it reaches the broker. */
export interface QueueEnqueueStep {
  queue: string;
  payload: unknown;
  options: QueueAddOptions;
}

/** The context of `beforeEnqueue` hooks: the request of `req.queue.add`, undefined for other callers. */
export interface QueueEnqueueContext {
  req: ServiceRequest | undefined;
}

/** What `afterEnqueue` hooks observe. */
export interface QueueEnqueued {
  queue: string;
  id: string;
  deduplicated: boolean;
}

/** What `beforeProcess` hooks receive and may return with a changed payload. */
export interface QueueProcessStep {
  message: QueueReceivedMessage;
  payload: unknown;
}

/** What `afterProcess` hooks observe after each run: its status, and its result or error. */
export interface QueueProcessed {
  message: QueueReceivedMessage;
  status: "completed" | "failed";
  result?: unknown;
  error?: unknown;
  durationMs: number;
}

/** What `onDead` hooks observe when a message used its last attempt. */
export interface QueueDeadMessage {
  message: QueueReceivedMessage;
  error: unknown;
}

/** The payload of the `queue.message.completed`, `queue.message.failed` and `queue.message.dead` events. */
export interface QueueMessageEvent {
  messageId: string;
  queue: string;
  attempt: number;
  durationMs?: number;
  error?: { message: string };
}

/** The feature API of `queues`, reached with `ctx.feature("queues")` from a feature that lists `queues` in `requires` or `after`. */
export interface QueuesApi {
  /**
   * Replaces the database broker with `broker`, from the calling feature's setup only; startup fails with
   * `Queue broker set by <a> and <b>; keep one` when `queues.broker` or another feature set one too.
   */
  setBroker(broker: QueueBroker): void;
  /**
   * Checks the broker for the readiness check: resolves with its fields (the database broker's `waiting` and
   * `oldestWaitingMs`), or `{}` for a broker without `health`, and throws when it cannot take messages.
   */
  health(): Promise<Record<string, unknown>>;
  /** Appends a `beforeEnqueue` hook after the config's; it may change the call or throw to cancel the `add`. */
  addHook(name: "beforeEnqueue", fn: FeatureHook<QueueEnqueueStep, QueueEnqueueContext>): void;
  /** Appends an `afterEnqueue` hook after the config's. */
  addHook(name: "afterEnqueue", fn: FeatureHook<QueueEnqueued, undefined>): void;
  /** Appends a `beforeProcess` hook after the config's; it may change the payload or throw to fail the attempt. */
  addHook(name: "beforeProcess", fn: FeatureHook<QueueProcessStep, undefined>): void;
  /** Appends an `afterProcess` hook after the config's. */
  addHook(name: "afterProcess", fn: FeatureHook<QueueProcessed, undefined>): void;
  /** Appends an `onDead` hook after the config's. */
  addHook(name: "onDead", fn: FeatureHook<QueueDeadMessage, undefined>): void;
}
