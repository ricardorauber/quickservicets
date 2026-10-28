import type { JobClock, Logger } from "../public.ts";
import type { QueueMessage } from "./message.ts";
import type { QueueAddResult } from "./queue.ts";

/** The effective options of one queue: its file's options over the overrides, the environment and the defaults. */
export interface QueueSettings {
  concurrency: number;
  timeout: string;
  retries: number;
  retryDelay: string;
  maxRetryDelay: string;
  /** How long a completed message keeps deduplicating its key; without it, a key is free once its message finished. */
  dedupeWindow?: string;
}

/** A message `add` hands to the broker. */
export interface QueueBrokerMessage {
  queue: string;
  /** The payload, already checked to be JSON. */
  payload: unknown;
  /** When the message may run first. */
  runAt: Date;
  /** Higher priorities run first, from -100 to 100. */
  priority: number;
  /** The queue's retries plus one. */
  maxAttempts: number;
  /** At most one live message of the queue has this key. */
  dedupeKey?: string;
  /** How long a completed message of the queue keeps deduplicating its key. */
  dedupeWindow?: string;
  /** The request that added it, when there is one. */
  requestId?: string;
  /** The ids of the user and tenant of the request that added it, when it had them. */
  actor?: QueueActor;
  /** The tenant the message was added for; its consumer runs in that tenant's scope. */
  tenant?: string;
  /** The W3C `traceparent` of the span that added it, while a tracer is set; brokers keep it when they can. */
  trace?: string;
}

/** Who added a message: the ids of the request's user and tenant. */
export interface QueueActor {
  user?: string;
  tenant?: string;
  /** The database scope the message was added in (`tenant:<id>` for tenants), when not the root one. */
  scope?: string;
}

/** A message a broker hands to `handle`. */
export interface QueueReceivedMessage {
  id: string;
  queue: string;
  payload: unknown;
  /** The current attempt, starting at 1. */
  attempt: number;
  enqueuedAt: Date;
  dedupeKey?: string;
  /** The request that added it, when the broker keeps it. */
  requestId?: string;
  /** The user and tenant of the request that added it, when the broker keeps them. */
  actor?: QueueActor;
  /** The tenant the message was added for, when the broker keeps it. */
  tenant?: string;
  /** The `traceparent` of the span that added it, when the broker keeps it. */
  trace?: string;
}

/** How a run ended: completed with the consumer's return value, or failed with what it threw. */
export type QueueOutcome = { completed: true; result?: unknown } | { failed: unknown };

/** The number of messages of one queue by status, and when its oldest waiting message was added. */
export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  dead: number;
  /** When the oldest `waiting` message was added, or null without one. */
  oldestWaiting: Date | null;
}

/** What a broker reports after each outcome: a completed run, a failed attempt, or a message that used its last attempt. */
export type QueueOutcomeReport =
  | { type: "completed"; message: QueueReceivedMessage; result?: unknown; durationMs: number }
  | { type: "failed"; message: QueueReceivedMessage; error: unknown; durationMs: number }
  | { type: "dead"; message: QueueReceivedMessage; error: unknown };

/** What `start` receives: the queues to consume and how to run their consumers. */
export interface QueueBrokerContext {
  /** The declared queues with their effective options. */
  queues: readonly { name: string; options: QueueSettings }[];
  /**
   * Runs the queue's consumer with the consumer context for one message; `signal` aborts it (a timeout, a shutdown).
   * Never rejects.
   */
  handle(message: QueueReceivedMessage, options: { signal: AbortSignal }): Promise<QueueOutcome>;
  /**
   * Tells the native how a run ended once the broker recorded it, so its hooks and events see every outcome (failed
   * attempts, timeouts and dead messages included); brokers call it after each outcome. Never throws.
   */
  report(outcome: QueueOutcomeReport): void;
  /** How long an idle consumer waits before it looks for messages again (`queues.pollInterval`). */
  pollInterval: string;
  logger: Logger;
  /** The time source and timers; tests pass a fake one. */
  clock: JobClock;
}

/**
 * Where messages live and how they reach their consumers. The database broker is the default; another broker (a
 * package for RabbitMQ, Kafka, Redis or SQS, or the project's own) replaces it with `queues: { broker }` or a feature's
 * `setBroker`, and passes `runQueueBrokerContract` from `@quickservicets/core/testing`.
 */
export interface QueueBroker {
  /** How errors name the broker, like `database` (default `custom`). */
  readonly name?: string;
  /**
   * Stores a message. With `transactional: true` the caller runs inside a database transaction: a broker that cannot
   * join it publishes once it commits (`afterCommit`), so a rolled-back transaction publishes nothing.
   */
  enqueue(message: QueueBrokerMessage, options: { transactional: boolean }): Promise<QueueAddResult>;
  /** Starts consuming the declared queues, calling `ctx.handle` for each message. */
  start(ctx: QueueBrokerContext): void | Promise<void>;
  /** Stops taking new messages when the shutdown starts, before `stop` drains (optional). */
  pause?(): void;
  /** Stops consuming, waiting up to `graceMs` for running messages, and gives back the ones still running. */
  stop(options: { graceMs: number }): Promise<void>;
  /** The number of messages per queue and status. */
  stats(): Promise<Record<string, QueueStats>>;
  /** Moves a dead message back to waiting (optional). */
  retry?(id: string): Promise<void>;
  /** Moves every dead message of a queue back to waiting, resolving with how many (optional). */
  retryDead?(queue: string): Promise<number>;
  /** The latest dead messages of a queue (optional). */
  dead?(queue: string, options: { limit?: number }): Promise<QueueMessage[]>;
  /** Deletes finished messages past their retention (optional). */
  cleanup?(): Promise<{ completed: number; dead: number }>;
  /** Resolves with fields for the readiness check when the broker can take messages, and throws otherwise (optional). */
  health?(): Promise<Record<string, unknown> | void>;
}

/** The optional methods of a broker. */
export type OptionalBrokerMethod = "retry" | "retryDead" | "dead" | "cleanup" | "health";

/** The error of a call to an optional method a broker lacks. */
export const unsupported = (broker: QueueBroker, method: OptionalBrokerMethod) => new Error(`The ${broker.name ?? "custom"} queue broker does not support ${method}`);

/** The broker's optional method, bound, or a throw naming the broker and the method. */
export function brokerMethod<M extends OptionalBrokerMethod>(broker: QueueBroker, method: M): NonNullable<QueueBroker[M]> {
  const fn = broker[method];
  if (typeof fn !== "function") throw unsupported(broker, method);
  return fn.bind(broker) as NonNullable<QueueBroker[M]>;
}
