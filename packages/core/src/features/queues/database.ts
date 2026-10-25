import { hostname } from "node:os";
import {
  UniqueViolationError,
  afterCommit,
  heartbeatInterval,
  operationContextEnabled,
  parseDuration,
  runError,
  safeLog,
  storableResult,
  systemClock,
  withOperation,
  type Condition,
  type DatabaseAdapter,
  type EntityModel,
  type JobClock,
  type JobLogFields,
  type JobLogger,
  type Logger,
  type Repositories,
  type StoredRecord,
} from "../public.ts";
import type { QueueBroker, QueueBrokerContext, QueueOutcome, QueueReceivedMessage, QueueStats } from "./broker.ts";
import { queueMessageEntity, type QueueMessage } from "./message.ts";

/** How often every process with consumers returns messages whose lease expired to `waiting`. */
export const RECLAIM_INTERVAL = 60_000;

/** Rows read per page when reclaiming. */
const RECLAIM_BATCH = 1000;

/** How the database broker reaches its table; the native fills what is not given from the project's config. */
export interface DatabaseBrokerOptions {
  /** The database (default: the project's `database`). */
  adapter?: DatabaseAdapter;
  /** The `QueueMessage` model the database was connected with (default: the built-in one). */
  model?: EntityModel;
  /** How long an idle loop waits before it looks for messages again (default: the start context's, else `1s`). */
  pollInterval?: string;
  /** Logs outside consumption, like `queue.cleanup` from the CLI (default: the start context's logger). */
  logger?: Logger;
  /** Hides error stacks in stored messages (default: the project's `production`). */
  production?: boolean;
  /** The largest result stored on a completed message (default: `jobs.limits.result`). */
  resultLimit?: string | number;
  /** How long finished messages are kept (default: completed 7 days, dead 30 days). */
  retention?: { completed: string; dead: string };
  /** The time source and timers before `start` (default: the system clock); `start` uses its context's clock. */
  clock?: JobClock;
  /** How the process names itself in `worker` (default: `<hostname>:<pid>`). */
  worker?: string;
  /** A number from 0 to 1 that sets the jitter of retry delays (default: `Math.random`). */
  random?: () => number;
  /** Queue names `stats` lists even without messages, besides the started ones. */
  queues?: readonly string[];
}

/** How often every process with consumers deletes finished messages past their retention. */
export const CLEANUP_INTERVAL = 3_600_000;

/** Messages deleted per batch by the retention cleanup. */
export const CLEANUP_BATCH = 1000;

/** The default broker: messages in the project's own database, consumed by every process that starts it. */
export interface DatabaseBroker extends QueueBroker {
  readonly name: "database";
  pause(): void;
  retry(id: string): Promise<void>;
  retryDead(queue: string): Promise<number>;
  dead(queue: string, options?: { limit?: number }): Promise<QueueMessage[]>;
  cleanup(): Promise<{ completed: number; dead: number }>;
  /** Resolves with the number of waiting messages and the age of the oldest one. */
  health(): Promise<{ waiting: number; oldestWaitingMs: number | null }>;
  /** Runs a queue's loop at once, as an `add` in this process does. */
  wake(name: string): void;
  /** Returns the `active` messages whose lease passed to `waiting`, or `dead` after their last attempt; resolves with how many. */
  reclaim(): Promise<number>;
  /** How many messages this process runs now, by queue. */
  running(): Record<string, number>;
}

const BIND = Symbol.for("quickservice.queues.database-broker");

/** Whether a broker is one `databaseBroker()` returned. */
export function isDatabaseBroker(value: unknown): value is DatabaseBroker {
  return typeof value === "object" && value !== null && typeof (value as Record<symbol, unknown>)[BIND] === "function";
}

/** Gives a database broker the options it was not created with, from the project's config. */
export function bindDatabaseBroker(broker: DatabaseBroker, defaults: DatabaseBrokerOptions): void {
  (broker as unknown as Record<symbol, (defaults: DatabaseBrokerOptions) => void>)[BIND]!(defaults);
}

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

interface Loop {
  name: string;
  active: number;
  timer?: unknown;
  ticking: boolean;
  again: boolean;
}

/** A running message, until its outcome is stored. */
interface Running {
  row: QueueMessage;
  controller: AbortController;
  /** Settles the run with an outcome; the first one wins. */
  settle(outcome: Outcome): void;
  done: Promise<void>;
}

type Outcome = { kind: "completed"; value: unknown } | { kind: "failed"; error: unknown } | { kind: "timedOut"; timeout: string } | { kind: "interrupted" };

/** A stored message as `handle` and reports see it. */
const receivedOf = (row: QueueMessage): QueueReceivedMessage => ({
  id: row.id,
  queue: row.queue,
  payload: row.payload,
  attempt: row.attempt,
  enqueuedAt: new Date(row.enqueuedAt),
  ...(row.dedupeKey ? { dedupeKey: row.dedupeKey } : {}),
});

const outcomeOf = (result: QueueOutcome): Outcome => ("failed" in result ? { kind: "failed", error: result.failed } : { kind: "completed", value: result.result });

/** The share of a retry delay its random jitter may add or remove. */
export const RETRY_JITTER = 0.1;

/** The value of the unique `dedupeSlot` column of a live message with a dedupe key. */
export const slotOf = (queue: string, dedupeKey: string) => `${queue}:${dedupeKey}`;

const condition = (field: string, op: "eq" | "lt" | "lte" | "gt", value: unknown): Condition => ({ field, op, value }) as Condition;

/** The reason `ctx.signal` is aborted with when the worker shuts down. */
const shutdownReason = () => new DOMException("Interrupted by shutdown", "AbortError");

/** The reason `ctx.signal` is aborted with when a message runs longer than its timeout. */
const timeoutReason = (timeout: string) => new DOMException(`Timed out after ${timeout}`, "TimeoutError");

/** Calls `fn` every `ms` on `clock` until the returned function is called. */
function repeat(clock: JobClock, ms: number, fn: () => void): () => void {
  let handle: unknown;
  let stopped = false;
  const arm = () => {
    handle = clock.setTimeout(() => {
      if (stopped) return;
      arm();
      fn();
    }, ms);
  };
  arm();
  return () => {
    stopped = true;
    clock.clearTimeout(handle);
  };
}

/**
 * The database broker: messages in the `QueueMessage` table of the project's database, claimed with conditional
 * updates and leases, so every process that starts it consumes them safely next to the others. The native uses it
 * unless another broker is set; its options default to the project's config.
 */
export function databaseBroker(options: DatabaseBrokerOptions = {}): DatabaseBroker {
  let config: DatabaseBrokerOptions = { ...options };
  let context: QueueBrokerContext | undefined;
  let defaultModel: EntityModel | undefined;
  const loops = new Map<string, Loop>();
  const runs = new Map<string, Running>();
  let claiming = false;
  let stopReclaiming: (() => void) | undefined;
  let stopCleaning: (() => void) | undefined;

  const adapterOf = (): DatabaseAdapter => {
    if (!config.adapter) throw new Error("The database queue broker has no database; pass databaseBroker({ adapter }) or enable the queues native");
    return config.adapter;
  };
  const modelOf = (): EntityModel => config.model ?? (defaultModel ??= queueMessageEntity());
  const clockOf = (): JobClock => context?.clock ?? config.clock ?? systemClock;
  const worker = () => config.worker ?? `${hostname()}:${process.pid}`;
  const random = () => (config.random ?? Math.random)();
  const settingsOf = (name: string) => context?.queues.find((entry) => entry.name === name)?.options;
  const timestamp = () => new Date(clockOf().now()).toISOString();
  const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) =>
    safeLog(context?.logger ?? config.logger ?? silentLogger, level, { timestamp: timestamp(), message, ...fields });
  const timeoutText = (name: string) => settingsOf(name)?.timeout ?? "5m";
  const timeoutOf = (name: string) => parseDuration(timeoutText(name)) ?? 300_000;

  const schedule = (loop: Loop, ms: number) => {
    clockOf().clearTimeout(loop.timer);
    loop.timer = clockOf().setTimeout(() => {
      loop.timer = undefined;
      void tick(loop);
    }, ms);
  };

  /** Claims a candidate with a conditional update; null when another worker claimed it first. */
  const claim = (row: StoredRecord): Promise<StoredRecord | null> => {
    const now = new Date(clockOf().now());
    const attempt = row.attempt as number;
    return adapterOf().updateById(
      modelOf(),
      row.id,
      { status: "active", attempt: attempt + 1, startedAt: now, worker: worker(), lockedUntil: new Date(now.getTime() + timeoutOf(row.queue as string)), updatedAt: now },
      [condition("status", "eq", "waiting"), condition("attempt", "eq", attempt)],
    );
  };

  /** Claims up to `count` due messages of a queue, trying the next candidate when another worker wins one. */
  const claimDue = async (name: string, count: number): Promise<QueueMessage[]> => {
    const now = new Date(clockOf().now());
    const { data } = await adapterOf().findMany(modelOf(), {
      where: [condition("queue", "eq", name), condition("status", "eq", "waiting"), condition("runAt", "lte", now)],
      // Higher priorities first, then the earliest due, then the oldest.
      sort: [{ field: "priority", direction: "desc" }, { field: "runAt", direction: "asc" }, { field: "id", direction: "asc" }],
      limit: count * 2 + 8,
      offset: 0,
      withTotal: false,
    });
    const claimed: QueueMessage[] = [];
    for (const row of data) {
      if (claimed.length >= count || !claiming) break;
      const won = await claim(row);
      if (won) claimed.push(won as unknown as QueueMessage);
    }
    return claimed;
  };

  const tick = async (loop: Loop): Promise<void> => {
    if (!claiming) return;
    if (loop.ticking) {
      loop.again = true;
      return;
    }
    loop.ticking = true;
    try {
      do {
        loop.again = false;
        const free = (settingsOf(loop.name)?.concurrency ?? 1) - loop.active;
        if (free <= 0) break;
        const claimed = await claimDue(loop.name, free);
        for (const row of claimed) begin(loop, row);
        // A full batch may leave more due messages; an empty or partial one waits for the next poll.
        if (claimed.length === free) loop.again = true;
      } while (loop.again && claiming);
    } catch (error) {
      log("error", "queue.claim.failed", { queue: loop.name, error: { message: (error as Error)?.message ?? String(error) } });
    } finally {
      loop.ticking = false;
      if (claiming) schedule(loop, parseDuration(context?.pollInterval ?? config.pollInterval ?? "1s") ?? 1000);
    }
  };

  const wakeLoop = (loop: Loop | undefined) => {
    if (!loop || !claiming) return;
    clockOf().clearTimeout(loop.timer);
    loop.timer = undefined;
    void tick(loop);
  };

  /** Stores the outcome of a run, unless another process took the message over since. */
  const record = async (row: QueueMessage, outcome: Outcome, startedAt: number) => {
    const now = new Date(clockOf().now());
    const durationMs = now.getTime() - startedAt;
    const fields = { queue: row.queue, messageId: row.id, attempt: row.attempt };
    const guard = [condition("status", "eq", "active"), condition("attempt", "eq", row.attempt)];
    if (outcome.kind === "interrupted") {
      // Not counted: the next worker runs the same attempt again.
      await adapterOf().updateById(modelOf(), row.id, { status: "waiting", attempt: row.attempt - 1, startedAt: null, worker: null, lockedUntil: null, updatedAt: now }, guard);
      log("warn", "queue.message.interrupted", fields);
      return;
    }
    const received = receivedOf(row);
    if (outcome.kind === "completed") {
      const { result, note } = storableResult(outcome.value, config.resultLimit ?? "64KB");
      if (note) log("warn", note, { queue: row.queue, messageId: row.id });
      // Without a dedupe window the key is free again once the message completed.
      const release = row.dedupeKey && !settingsOf(row.queue)?.dedupeWindow ? { dedupeSlot: null } : {};
      await adapterOf().updateById(modelOf(), row.id, { status: "completed", finishedAt: now, lockedUntil: null, ...release, ...(result !== undefined ? { result: result as StoredRecord[string] } : {}), updatedAt: now }, guard);
      log("info", "queue.message.completed", { ...fields, durationMs });
      context?.report({ type: "completed", message: received, result: outcome.value, durationMs });
      return;
    }
    const lastError = outcome.kind === "timedOut" ? { message: `Timed out after ${outcome.timeout}` } : runError(outcome.error, config.production ?? false);
    const error = outcome.kind === "timedOut" ? new Error(lastError.message) : outcome.error;
    log("warn", "queue.message.failed", { ...fields, durationMs, error: { message: lastError.message } });
    context?.report({ type: "failed", message: received, error, durationMs });
    await fail(row, lastError, now, guard, error);
  };

  /** How long a message waits before its next attempt: the doubled delay up to the longest, with a random jitter. */
  const retryDelayOf = (row: QueueMessage) => {
    const settings = settingsOf(row.queue);
    const base = (parseDuration(settings?.retryDelay ?? "10s") ?? 10_000) * 2 ** (row.attempt - 1);
    const capped = Math.min(base, parseDuration(settings?.maxRetryDelay ?? "1h") ?? 3_600_000);
    return Math.max(0, Math.round(capped * (1 + (random() * 2 - 1) * RETRY_JITTER)));
  };

  /** The failure rule: back to `waiting` after a delay while attempts remain, `dead` after the last one. */
  const fail = async (row: QueueMessage, lastError: { message: string; stack?: string }, now: Date, guard: Condition[], error: unknown = new Error(lastError.message)) => {
    if (row.attempt < row.maxAttempts) {
      const runAt = new Date(now.getTime() + retryDelayOf(row));
      return adapterOf().updateById(modelOf(), row.id, { status: "waiting", runAt, lastError, lockedUntil: null, worker: null, updatedAt: now }, guard);
    }
    const dead = await adapterOf().updateById(modelOf(), row.id, { status: "dead", finishedAt: now, lastError, lockedUntil: null, dedupeSlot: null, updatedAt: now }, guard);
    if (dead) {
      log("error", "queue.message.dead", { queue: row.queue, messageId: row.id, attempt: row.attempt, error: { message: lastError.message } });
      context?.report({ type: "dead", message: receivedOf(row), error });
    }
    return dead;
  };

  /** Runs a claimed message in the background through the start context's `handle`, waking its loop once it finished. */
  const begin = (loop: Loop, row: QueueMessage) => {
    loop.active++;
    const clock = clockOf();
    const controller = new AbortController();
    const timeoutMs = timeoutOf(row.queue);
    const startedAt = clock.now();
    const outcome = Promise.withResolvers<Outcome>();
    let settled = false;
    const settle = (value: Outcome) => {
      if (settled) return;
      settled = true;
      outcome.resolve(value);
    };
    // While the message runs, its lease is renewed every third of the timeout.
    const stopLease = repeat(clock, heartbeatInterval(timeoutMs), () => {
      const now = clock.now();
      adapterOf()
        .updateById(modelOf(), row.id, { lockedUntil: new Date(now + timeoutMs), updatedAt: new Date(now) }, [condition("status", "eq", "active"), condition("attempt", "eq", row.attempt)])
        .catch(() => {});
    });
    // A message running longer than its timeout fails at once; its handler settling later changes nothing.
    const timeout = timeoutText(row.queue);
    let timeoutHandle: unknown = clock.setTimeout(() => {
      timeoutHandle = undefined;
      controller.abort(timeoutReason(timeout));
      settle({ kind: "timedOut", timeout });
    }, timeoutMs);
    log("info", "queue.message.started", { queue: row.queue, messageId: row.id, attempt: row.attempt });
    const received = receivedOf(row);
    Promise.resolve()
      .then(() => context!.handle(received, { signal: controller.signal }))
      .then(
        (result) => settle(outcomeOf(result)),
        (error: unknown) => settle({ kind: "failed", error }),
      );
    const done = outcome.promise
      .then((result) => {
        stopLease();
        clock.clearTimeout(timeoutHandle);
        return record(row, result, startedAt);
      })
      .catch((error: unknown) => log("error", "queue.record.failed", { queue: row.queue, messageId: row.id, error: { message: (error as Error)?.message ?? String(error) } }))
      .finally(() => {
        runs.delete(row.id);
        loop.active--;
        wakeLoop(loop);
      });
    runs.set(row.id, { row, controller, settle, done });
  };

  const reclaim = async (): Promise<number> => {
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const now = new Date(clockOf().now());
      const { data } = await adapterOf().findMany(modelOf(), {
        where: [condition("status", "eq", "active"), condition("lockedUntil", "lt", now), ...(after ? [condition("id", "gt", after)] : [])],
        sort: [{ field: "id", direction: "asc" }],
        limit: RECLAIM_BATCH,
        offset: 0,
        withTotal: false,
      });
      for (const row of data) {
        if (runs.has(row.id)) continue;
        const guard = [condition("status", "eq", "active"), condition("lockedUntil", "eq", row.lockedUntil)];
        const message = row as unknown as QueueMessage;
        // A message whose last attempt lost its lease has failed; the others run that attempt's successor.
        const returned =
          message.attempt >= message.maxAttempts
            ? await fail(message, { message: `Lease expired after ${timeoutText(message.queue)}` }, now, guard)
            : await adapterOf().updateById(modelOf(), row.id, { status: "waiting", worker: null, lockedUntil: null, updatedAt: now }, guard);
        if (!returned) continue;
        count++;
        log("info", "queue.message.reclaimed", { queue: row.queue, messageId: row.id, attempt: row.attempt });
      }
      if (data.length < RECLAIM_BATCH) break;
      after = data.at(-1)!.id;
    }
    if (count > 0) for (const loop of loops.values()) wakeLoop(loop);
    return count;
  };

  const reclaimSafely = () =>
    void reclaim().catch((error: unknown) => log("error", "queue.reclaim.failed", { error: { message: (error as Error)?.message ?? String(error) } }));

  /** Moves one dead message back to waiting; false when it is no longer dead. */
  const requeue = async (row: StoredRecord): Promise<boolean> => {
    const now = new Date(clockOf().now());
    const key = row.dedupeKey as string | null | undefined;
    const slot = key ? slotOf(row.queue as string, key) : undefined;
    const inUse = (holder: StoredRecord) => new Error(`Queue message ${row.id} has dedupe key ${key} in use by ${holder.id}`);
    if (slot) {
      // The key goes back to the message, unless a newer message holds it.
      const holder = await adapterOf().findOne(modelOf(), [condition("dedupeSlot", "eq", slot)]);
      if (holder && holder.id !== row.id) {
        if (deduplicates(holder, now)) throw inUse(holder);
        await release(holder, slot, now);
      }
    }
    let requeued: StoredRecord | null;
    try {
      requeued = await adapterOf().updateById(
        modelOf(),
        row.id,
        { status: "waiting", attempt: 0, runAt: now, finishedAt: null, startedAt: null, lockedUntil: null, worker: null, ...(slot ? { dedupeSlot: slot } : {}), updatedAt: now },
        [condition("status", "eq", "dead")],
      );
    } catch (error) {
      if (!(error instanceof UniqueViolationError) || !slot) throw error;
      const holder = await adapterOf().findOne(modelOf(), [condition("dedupeSlot", "eq", slot)]);
      throw holder ? inUse(holder) : error;
    }
    if (requeued) wakeLoop(loops.get(row.queue as string));
    return requeued !== null;
  };

  /** Every message matching `where`, read in pages of 1000 by id. */
  const rowsWhere = async (where: Condition[]): Promise<StoredRecord[]> => {
    const rows: StoredRecord[] = [];
    let after: string | undefined;
    for (;;) {
      const { data } = await adapterOf().findMany(modelOf(), { where: [...where, ...(after ? [condition("id", "gt", after)] : [])], sort: [{ field: "id", direction: "asc" }], limit: 1000, offset: 0, withTotal: false });
      rows.push(...data);
      if (data.length < 1000) return rows;
      after = data.at(-1)!.id;
    }
  };

  /** Deletes the messages of one status finished before `cutoff`, in batches; each deletion counts once across instances. */
  const deleteFinished = async (status: "completed" | "dead", cutoff: Date): Promise<number> => {
    let deleted = 0;
    let after: string | undefined;
    for (;;) {
      const { data } = await adapterOf().findMany(modelOf(), {
        where: [condition("status", "eq", status), condition("finishedAt", "lt", cutoff), ...(after ? [condition("id", "gt", after)] : [])],
        sort: [{ field: "id", direction: "asc" }],
        limit: CLEANUP_BATCH,
        offset: 0,
        withTotal: false,
      });
      for (const row of data) if (await adapterOf().deleteById(modelOf(), row.id)) deleted++;
      if (data.length < CLEANUP_BATCH) return deleted;
      after = data.at(-1)!.id;
    }
  };

  const cleanup = async () => {
    const now = clockOf().now();
    const retention = config.retention ?? { completed: "7d", dead: "30d" };
    const completed = await deleteFinished("completed", new Date(now - (parseDuration(retention.completed) ?? 7 * 86_400_000)));
    const dead = await deleteFinished("dead", new Date(now - (parseDuration(retention.dead) ?? 30 * 86_400_000)));
    log("info", "queue.cleanup", { completed, dead });
    return { completed, dead };
  };

  const cleanupSafely = () =>
    void cleanup().catch((error: unknown) => log("error", "queue.cleanup.failed", { error: { message: (error as Error)?.message ?? String(error) } }));

  /** Inserts a message unless another one holds its dedupe slot; resolves null then. */
  const insertOrSkip = async (row: StoredRecord): Promise<StoredRecord | null> => {
    const adapter = adapterOf();
    if (adapter.insertOrSkip) return adapter.insertOrSkip(modelOf(), row, "dedupeSlot");
    try {
      return await adapter.insert(modelOf(), row);
    } catch (error) {
      if (error instanceof UniqueViolationError) return null;
      throw error;
    }
  };

  /**
   * Whether a message holding a dedupe slot still deduplicates its key: while it is live, or completed within the
   * window (the message's being added, else its queue's).
   */
  const deduplicates = (holder: StoredRecord, now: Date, dedupeWindow = settingsOf(holder.queue as string)?.dedupeWindow): boolean => {
    if (holder.status === "waiting" || holder.status === "active") return true;
    if (holder.status !== "completed" || !holder.finishedAt) return false;
    const window = parseDuration(dedupeWindow);
    return window !== undefined && new Date(holder.finishedAt as Date).getTime() >= now.getTime() - window;
  };

  /** Frees the slot of a message that no longer deduplicates, unless it changed since it was read. */
  const release = (holder: StoredRecord, slot: string, now: Date) =>
    adapterOf().updateById(modelOf(), holder.id, { dedupeSlot: null, updatedAt: now }, [condition("dedupeSlot", "eq", slot), condition("status", "eq", holder.status)]);

  const pause = () => {
    claiming = false;
    stopReclaiming?.();
    stopReclaiming = undefined;
    stopCleaning?.();
    stopCleaning = undefined;
    for (const loop of loops.values()) {
      clockOf().clearTimeout(loop.timer);
      loop.timer = undefined;
    }
  };

  const broker: DatabaseBroker = {
    name: "database",
    async enqueue(message) {
      const now = new Date(clockOf().now());
      const { queue: name, dedupeKey } = message;
      const row: StoredRecord = {
        id: Bun.randomUUIDv7(),
        createdAt: now,
        updatedAt: now,
        queue: name,
        payload: message.payload as StoredRecord[string],
        status: "waiting",
        priority: message.priority,
        runAt: message.runAt,
        attempt: 0,
        maxAttempts: message.maxAttempts,
        enqueuedAt: now,
        ...(message.requestId ? { requestId: message.requestId } : {}),
      };
      const wake = () => void afterCommit(() => wakeLoop(loops.get(name)));
      if (dedupeKey === undefined) {
        // Inside a transaction the insert joins it, so the message exists only once the transaction commits.
        await adapterOf().insert(modelOf(), row);
        wake();
        return { id: row.id, deduplicated: false };
      }
      const slot = slotOf(name, dedupeKey);
      // The unique slot lets one of several concurrent adds insert; the others find the message holding it.
      for (let round = 0; round < 5; round++) {
        if (await insertOrSkip({ ...row, dedupeKey, dedupeSlot: slot })) {
          wake();
          return { id: row.id, deduplicated: false };
        }
        const holder = await adapterOf().findOne(modelOf(), [condition("dedupeSlot", "eq", slot)]);
        if (!holder) continue;
        if (deduplicates(holder, now, message.dedupeWindow)) {
          log("info", "queue.message.deduplicated", { queue: name, dedupeKey, messageId: holder.id });
          return { id: holder.id, deduplicated: true };
        }
        await release(holder, slot, now);
      }
      throw new Error(`Queue message for ${name} with dedupe key ${dedupeKey} could not be added; try again`);
    },
    start(ctx) {
      if (claiming) return;
      context = ctx;
      claiming = true;
      loops.clear();
      for (const { name } of ctx.queues) {
        const loop: Loop = { name, active: 0, ticking: false, again: false };
        loops.set(name, loop);
        wakeLoop(loop);
      }
      reclaimSafely();
      stopReclaiming = repeat(ctx.clock, RECLAIM_INTERVAL, reclaimSafely);
      cleanupSafely();
      stopCleaning = repeat(ctx.clock, CLEANUP_INTERVAL, cleanupSafely);
    },
    wake(name) {
      wakeLoop(loops.get(name));
    },
    reclaim,
    pause,
    async stop({ graceMs }) {
      // A service whose startup failed stops without a shutdown, so stopping also pauses.
      pause();
      const current = [...runs.values()];
      for (const entry of current) entry.controller.abort(shutdownReason());
      let timer: unknown;
      await Promise.race([Promise.allSettled(current.map((entry) => entry.done)), new Promise<void>((resolve) => (timer = clockOf().setTimeout(resolve, graceMs)))]);
      clockOf().clearTimeout(timer);
      // The handlers still running give their message back without counting the attempt.
      for (const entry of [...runs.values()]) entry.settle({ kind: "interrupted" });
      await Promise.allSettled(current.map((entry) => entry.done));
    },
    running() {
      return Object.fromEntries([...loops.values()].map((loop) => [loop.name, loop.active]));
    },
    async retry(id) {
      const row = await adapterOf().findById(modelOf(), id);
      if (!row) throw new Error(`Queue message ${id} not found`);
      if (row.status !== "dead" || !(await requeue(row))) throw new Error(`Queue message ${id} is not dead`);
    },
    async retryDead(queue) {
      let count = 0;
      for (const row of await rowsWhere([condition("queue", "eq", queue), condition("status", "eq", "dead")])) {
        try {
          if (await requeue(row)) count++;
        } catch (error) {
          // A message whose key a newer message holds stays dead.
          if (!(error instanceof Error) || !error.message.includes("in use by")) throw error;
        }
      }
      return count;
    },
    async dead(queue, { limit = 20 } = {}) {
      const { data } = await adapterOf().findMany(modelOf(), {
        where: [condition("queue", "eq", queue), condition("status", "eq", "dead")],
        sort: [{ field: "finishedAt", direction: "desc" }, { field: "id", direction: "desc" }],
        limit: Math.max(1, Math.floor(limit)),
        offset: 0,
        withTotal: false,
      });
      return data as unknown as QueueMessage[];
    },
    async stats() {
      const names = new Set([...(context?.queues.map((entry) => entry.name) ?? []), ...(config.queues ?? [])]);
      for (const row of await rowsWhere([{ field: "status", op: "in", value: ["waiting", "active", "dead"] } as Condition])) names.add(row.queue as string);
      const stats: Record<string, QueueStats> = {};
      for (const name of [...names].sort()) {
        const counts = await adapterOf().aggregate(modelOf(), [condition("queue", "eq", name)], {
          waiting: { fn: "count", where: [condition("status", "eq", "waiting")] },
          active: { fn: "count", where: [condition("status", "eq", "active")] },
          completed: { fn: "count", where: [condition("status", "eq", "completed")] },
          dead: { fn: "count", where: [condition("status", "eq", "dead")] },
        });
        const { oldest } = await adapterOf().aggregate(modelOf(), [condition("queue", "eq", name), condition("status", "eq", "waiting")], { oldest: { fn: "min", field: "enqueuedAt" } });
        stats[name] = {
          waiting: Number(counts.waiting),
          active: Number(counts.active),
          completed: Number(counts.completed),
          dead: Number(counts.dead),
          oldestWaiting: oldest === null || oldest === undefined ? null : new Date(oldest),
        };
      }
      return stats;
    },
    cleanup,
    async health() {
      const now = clockOf().now();
      const waiting = condition("status", "eq", "waiting");
      const counts = await adapterOf().aggregate(modelOf(), [waiting], { waiting: { fn: "count" }, oldest: { fn: "min", field: "enqueuedAt" } });
      const oldest = counts.oldest;
      return { waiting: Number(counts.waiting), oldestWaitingMs: oldest === null || oldest === undefined ? null : Math.max(0, now - new Date(oldest).getTime()) };
    },
  };
  Object.defineProperty(broker, BIND, {
    value: (defaults: DatabaseBrokerOptions) => {
      config = { ...defaults, ...options };
    },
  });
  return broker;
}
