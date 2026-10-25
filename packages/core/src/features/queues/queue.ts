import type { JobLogger, Repositories } from "../public.ts";

/**
 * The payload type of every queue of the project, by queue name; the build fills it in `.generated/types.ts` from the
 * files of `queues/`, so `add` with an unknown name or a wrong payload is a type error.
 */
export interface QueuePayloads {}

/** A queue name of the project. */
export type QueueName = Extract<keyof QueuePayloads, string>;

/** Options of one `add` call. */
export interface QueueAddOptions {
  /** Runs the message once this duration passed, like `5m`; not with `runAt`. */
  delay?: string;
  /** Runs the message at this time or later, a `Date` or ISO 8601 text; a time in the past runs as soon as possible. */
  runAt?: Date | string;
  /** Messages with a higher priority run first, from -100 to 100 (default 0). */
  priority?: number;
}

/** What `add` resolves with: the message's id, and whether an existing message was returned instead of a new one. */
export interface QueueAddResult {
  id: string;
  deduplicated: boolean;
}

/** Adds messages to the project's queues: `req.queue`, `ctx.queue` in jobs and consumers, and `queues` of the core. */
export interface QueueClient {
  /**
   * Adds a `waiting` message to the queue `name`; inside a transaction the message exists only once it commits. Throws
   * `Unknown queue <name>` for a queue that is not declared.
   */
  add<N extends QueueName>(name: N, payload: QueuePayloads[N], options?: QueueAddOptions): Promise<QueueAddResult>;
}

/** The message a consumer runs for. */
export interface QueueMessageInfo {
  id: string;
  /** The queue name. */
  queue: string;
  /** The current attempt, starting at 1. */
  attempt: number;
  enqueuedAt: Date;
  dedupeKey?: string;
}

/** What a queue consumer receives. */
export interface QueueContext<Payload = unknown> {
  /** The message's payload, as it was added. */
  payload: Payload;
  /** The typed repositories. */
  repos: Repositories;
  message: QueueMessageInfo;
  /** Aborted when the run times out or the worker shuts down. */
  signal: AbortSignal;
  /** Writes to the service logger with the queue and message id. */
  log: JobLogger;
  /** Adds more messages. */
  queue: QueueClient;
}

/** Per-queue settings; each one overrides the matching `queues` option. */
export interface QueueOptions {
  /** How many messages of the queue run at once in one process (integer, at least 1). */
  concurrency?: number;
  /** The longest a message may run, as a duration like `5m`. */
  timeout?: string;
  /** How many times a failed message is retried (integer, at least 0). */
  retries?: number;
  /** The delay before the first retry, doubled for each next one, as a duration like `10s`. */
  retryDelay?: string;
  /** How long a completed message keeps deduplicating its key, as a duration like `1h`. */
  dedupeWindow?: string;
}

const QUEUE_MARKER = Symbol.for("quickservice.queue");

/** A queue declared with `queue(...)`, default-exported by a file in `queues/`. */
export interface QueueDefinition<Payload = unknown> {
  readonly [QUEUE_MARKER]: true;
  /** Runs one message; resolving completes it, throwing fails the attempt. */
  handler(ctx: QueueContext<Payload>): unknown;
  options: QueueOptions;
}

/** The payload type of a queue definition. */
export type QueuePayloadOf<Q> = Q extends QueueDefinition<infer Payload> ? Payload : never;

/** Declares a queue's consumer. The default export of each file in `queues/` must be one. */
export function queue<Payload = unknown>(handler: (ctx: QueueContext<Payload>) => unknown, options: QueueOptions = {}): QueueDefinition<Payload> {
  if (typeof handler !== "function") throw new Error("queue(handler, options?) needs a handler function");
  return { [QUEUE_MARKER]: true, handler, options: { ...options } };
}

export function isQueueDefinition(value: unknown): value is QueueDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[QUEUE_MARKER] === true;
}
