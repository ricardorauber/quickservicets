import { parseDuration, safeLog, UniqueViolationError, type Condition, type DatabaseAdapter, type EntityModel, type FieldModel, type Logger, type StoredRecord } from "../public.ts";
import type { QueueOutcome, QueueReceivedMessage, QueueSettings } from "./broker.ts";

/** The share of a retry delay its random jitter may add or remove, as the database broker uses it. */
const JITTER = 0.1;

/** The message envelope external brokers carry, version 1. */
export interface QueueEnvelope {
  id: string;
  queue: string;
  payload: unknown;
  priority: number;
  runAt: Date;
  /** The attempt the message runs as next, starting at 1. */
  attempt: number;
  maxAttempts: number;
  dedupeKey?: string;
  tenant?: string;
  requestId?: string;
  enqueuedAt: Date;
  /** The producer's W3C `traceparent`, when a tracer was set. */
  trace?: string;
}

const REQUIRED = ["id", "queue", "priority", "runAt", "attempt", "maxAttempts", "enqueuedAt"] as const;

/** The JSON text of a message's envelope, `{ v: 1, ... }`, with its dates as ISO 8601. */
export function encodeQueueMessage(message: QueueEnvelope): string {
  return JSON.stringify({
    v: 1,
    id: message.id,
    queue: message.queue,
    payload: message.payload,
    priority: message.priority,
    runAt: new Date(message.runAt).toISOString(),
    attempt: message.attempt,
    maxAttempts: message.maxAttempts,
    ...(message.dedupeKey !== undefined ? { dedupeKey: message.dedupeKey } : {}),
    ...(message.tenant !== undefined ? { tenant: message.tenant } : {}),
    ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
    enqueuedAt: new Date(message.enqueuedAt).toISOString(),
    ...(message.trace !== undefined ? { trace: message.trace } : {}),
  });
}

/** The envelope an `encodeQueueMessage` text holds; throws `Invalid queue message: <reason>`. */
export function decodeQueueMessage(text: string): QueueEnvelope {
  const invalid = (reason: string) => new Error(`Invalid queue message: ${reason}`);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw invalid("not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("not an object");
  if (value.v !== 1) throw invalid(`unsupported version ${String(value.v)}`);
  for (const field of REQUIRED) if (value[field] === undefined || value[field] === null) throw invalid(`missing ${field}`);
  if (!Object.hasOwn(value, "payload")) throw invalid("missing payload");
  const date = (field: string) => {
    const parsed = new Date(value[field] as string);
    if (Number.isNaN(parsed.getTime())) throw invalid(`${field} is not a date`);
    return parsed;
  };
  return {
    id: String(value.id),
    queue: String(value.queue),
    payload: value.payload,
    priority: Number(value.priority),
    runAt: date("runAt"),
    attempt: Number(value.attempt),
    maxAttempts: Number(value.maxAttempts),
    ...(typeof value.dedupeKey === "string" ? { dedupeKey: value.dedupeKey } : {}),
    ...(typeof value.tenant === "string" ? { tenant: value.tenant } : {}),
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
    enqueuedAt: date("enqueuedAt"),
    ...(typeof value.trace === "string" ? { trace: value.trace } : {}),
  };
}

/**
 * When a failed attempt runs again: `retryDelay` doubled for each attempt after the first, at most `maxRetryDelay`,
 * with up to ±10% jitter, as the database broker retries; null once `attempt` reached `maxAttempts` (dead).
 */
export function nextRetryAt(attempt: number, options: { retryDelay: string; maxRetryDelay: string; maxAttempts?: number }, now: Date | number = Date.now(), random: () => number = Math.random): Date | null {
  if (options.maxAttempts !== undefined && attempt >= options.maxAttempts) return null;
  const base = (parseDuration(options.retryDelay) ?? 10_000) * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, parseDuration(options.maxRetryDelay) ?? 3_600_000);
  const delay = Math.max(0, Math.round(capped * (1 + (random() * 2 - 1) * JITTER)));
  return new Date((now instanceof Date ? now.getTime() : now) + delay);
}

/** The system entity external brokers keep their dedupe keys in: one slot per queue and key. */
export const queueDedupeEntity: EntityModel = (() => {
  const fields = [
    { name: "slot", type: "string", optional: false, unique: true, storage: "column" },
    { name: "messageId", type: "string", optional: false, storage: "column" },
    { name: "expiresAt", type: "date", optional: true, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "QueueDedupeKey",
    entityName: "QueueDedupeKey",
    schema: null,
    name: "queue-dedupe-keys",
    repoKey: "queueDedupeKeys",
    tableName: "queue_dedupe_keys",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    system: true,
    tenancy: "shared",
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
  } as EntityModel;
})();

const condition = (field: string, op: "eq" | "lt", value: unknown): Condition => ({ field, op, value }) as Condition;

/** Where a dedupe store keeps its slots: the project's database (`ctx.config.database`) and the entity it was built with. */
export interface DedupeStoreTarget {
  adapter: DatabaseAdapter;
  model?: EntityModel;
  now?: () => number;
}

/**
 * Dedupe keys of an external broker, kept in the project's database: `claim` takes a key's slot for a message (one of
 * two concurrent claims wins, through the unique slot), `release` frees it or keeps it for a `dedupeWindow`, and
 * `cleanup` deletes expired slots. Inside a transaction every call joins it.
 */
export function createDedupeStore(target: DedupeStoreTarget) {
  const model = target.model ?? queueDedupeEntity;
  const now = target.now ?? Date.now;
  const db = target.adapter;
  const slotOf = (queue: string, dedupeKey: string) => `${queue}:${dedupeKey}`;
  const find = (slot: string) => db.findOne(model, [condition("slot", "eq", slot)]);
  return {
    /** Takes the slot of a key for a message, or tells which message holds it. */
    async claim(input: { queue: string; dedupeKey: string; messageId: string }): Promise<{ claimed: true } | { claimed: false; messageId: string }> {
      const slot = slotOf(input.queue, input.dedupeKey);
      for (let round = 0; round < 3; round++) {
        const at = new Date(now());
        try {
          await db.insert(model, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, slot, messageId: input.messageId, expiresAt: null } as StoredRecord);
          return { claimed: true };
        } catch (error) {
          if (!(error instanceof UniqueViolationError)) throw error;
        }
        const holder = await find(slot);
        if (!holder) continue;
        const expires = holder.expiresAt ? new Date(holder.expiresAt as string).getTime() : undefined;
        if (expires === undefined || expires > now()) return { claimed: false, messageId: String(holder.messageId) };
        // An expired slot is free: whoever deletes it first claims it next.
        await db.deleteById(model, holder.id);
      }
      const holder = await find(slot);
      return { claimed: false, messageId: String(holder?.messageId ?? "") };
    },
    /** Frees a message's slot, or keeps it until `now + window` for a queue with a `dedupeWindow`. */
    async release(input: { queue: string; dedupeKey: string; messageId: string; window?: string }): Promise<void> {
      const holder = await find(slotOf(input.queue, input.dedupeKey));
      if (!holder || String(holder.messageId) !== input.messageId) return;
      const windowMs = input.window ? parseDuration(input.window) : undefined;
      if (windowMs && windowMs > 0) await db.updateById(model, holder.id, { expiresAt: new Date(now() + windowMs), updatedAt: new Date(now()) });
      else await db.deleteById(model, holder.id);
    },
    /** Deletes slots whose window passed; resolves how many. */
    async cleanup(): Promise<number> {
      let deleted = 0;
      for (;;) {
        const { data } = await db.findMany(model, { where: [condition("expiresAt", "lt", new Date(now()))], sort: [{ field: "id", direction: "asc" }], limit: 1000, offset: 0, withTotal: false });
        for (const row of data) if (await db.deleteById(model, row.id)) deleted++;
        if (data.length < 1000) return deleted;
      }
    },
  };
}

export type DedupeStore = ReturnType<typeof createDedupeStore>;

/** What a consumer pool runs. */
export interface ConsumerPoolOptions {
  /** The declared queues with their effective options (`concurrency` bounds each). */
  queues: readonly { name: string; options: Pick<QueueSettings, "concurrency"> }[];
  /** The broker context's `handle`. */
  handle(message: QueueReceivedMessage, options: { signal: AbortSignal }): Promise<QueueOutcome>;
  /** Aborts the running handlers when it aborts, like a shutdown. */
  signal?: AbortSignal;
  logger?: Logger;
}

/**
 * Runs decoded messages with at most each queue's `concurrency` at once per process: `push` waits while the queue is
 * full (back-pressure for the broker's fetch loop), then runs the message and calls `ack` after it completed or
 * `nack(outcome)` after it failed; `drain(graceMs)` resolves once the running handlers finished or the grace passed.
 */
export function createConsumerPool(options: ConsumerPoolOptions) {
  const limits = new Map(options.queues.map((queue) => [queue.name, Math.max(1, queue.options.concurrency ?? 1)]));
  const running = new Map<string, Set<Promise<void>>>();
  const waiters = new Map<string, (() => void)[]>();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const all = new Set<Promise<void>>();
  const free = (queue: string) => {
    const next = waiters.get(queue)?.shift();
    next?.();
  };
  const runningOf = (queue: string) => {
    let set = running.get(queue);
    if (!set) running.set(queue, (set = new Set()));
    return set;
  };
  return {
    /** Runs a message once its queue has room; resolves when it started. */
    async push(queue: string, message: QueueReceivedMessage, callbacks: { ack(): unknown; nack(outcome: { failed: unknown }): unknown }): Promise<void> {
      const limit = limits.get(queue) ?? 1;
      while (runningOf(queue).size >= limit) await new Promise<void>((resolve) => (waiters.get(queue) ?? waiters.set(queue, []).get(queue)!).push(resolve));
      const run = (async () => {
        try {
          const outcome = await options.handle(message, { signal });
          if ("failed" in outcome) await callbacks.nack(outcome);
          else await callbacks.ack();
        } catch (error) {
          if (options.logger) safeLog(options.logger, "error", { timestamp: new Date().toISOString(), message: "queue.pool.failed", queue, messageId: message.id, error: { message: (error as Error)?.message ?? String(error) } });
        }
      })();
      runningOf(queue).add(run);
      all.add(run);
      void run.finally(() => {
        runningOf(queue).delete(run);
        all.delete(run);
        free(queue);
      });
    },
    /** How many messages of a queue run now. */
    active(queue: string): number {
      return running.get(queue)?.size ?? 0;
    },
    /** Waits for the running handlers, at most `graceMs`, aborting them when the grace passed. */
    async drain(graceMs: number): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...all]), new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))]);
      clearTimeout(timer);
      if (all.size > 0) controller.abort(new DOMException("Interrupted by shutdown", "AbortError"));
    },
  };
}

export type ConsumerPool = ReturnType<typeof createConsumerPool>;

/** The name of a queue in an external broker: the prefix and the queue name with `/` as `.`. */
export function brokerName(queue: string, prefix = "quickservicets."): string {
  const name = `${prefix}${queue.replaceAll("/", ".")}`;
  if (name.length > 249) throw new Error(`Queue name ${queue} is not valid for brokers`);
  return name;
}

/** A failure of an external broker's service, reported to callers with the broker's name and the cause. */
export class QueueBrokerError extends Error {
  readonly broker: string;
  constructor(message: string, options: { broker: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "QueueBrokerError";
    this.broker = options.broker;
  }
}
