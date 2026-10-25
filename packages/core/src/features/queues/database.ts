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
import { queueClient } from "./client.ts";
import type { QueueMessage } from "./message.ts";
import type { QueueAddResult, QueueContext, QueueDefinition } from "./queue.ts";
import type { AddSource } from "./state.ts";
import type { MessagePlacement } from "./message-options.ts";

/** The effective settings of one queue. */
export interface QueueSettings {
  concurrency: number;
  timeout: string;
  retries: number;
  retryDelay: string;
  maxRetryDelay: string;
  /** How long a completed message keeps deduplicating its key; without it, a key is free once its message finished. */
  dedupeWindow?: string;
}

/** How often every process with consumers returns messages whose lease expired to `waiting`. */
export const RECLAIM_INTERVAL = 60_000;

/** Rows read per page when reclaiming. */
const RECLAIM_BATCH = 1000;

export interface DatabaseQueueOptions {
  adapter: DatabaseAdapter;
  /** The `QueueMessage` model the database was connected with. */
  model: EntityModel;
  /** The declared queues, by name; each gets a consumer loop. */
  definitions: ReadonlyMap<string, QueueDefinition>;
  /** The effective settings of a queue. */
  settings(name: string): QueueSettings;
  /** How long an idle loop waits before it looks for messages again. */
  pollInterval: string;
  logger: Logger;
  /** Hides error stacks in stored messages. */
  production: boolean;
  /** The largest result stored on a completed message (`jobs.limits.result`). */
  resultLimit: string | number;
  /** The time source and timers (default: the system clock). */
  clock?: JobClock;
  /** How the process names itself in `worker` (default: `<hostname>:<pid>`). */
  worker?: string;
  /** A number from 0 to 1 that sets the jitter of retry delays (default: `Math.random`). */
  random?: () => number;
  /** How long finished messages are kept (default: completed 7 days, dead 30 days). */
  retention?: { completed: string; dead: string };
}

/** The number of messages of one queue by status, and when its oldest waiting message was added. */
export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  dead: number;
  /** When the oldest `waiting` message was added, or null without one. */
  oldestWaiting: Date | null;
}

/** How often every process with consumers deletes finished messages past their retention. */
export const CLEANUP_INTERVAL = 3_600_000;

/** Messages deleted per batch by the retention cleanup. */
export const CLEANUP_BATCH = 1000;

/** The messages of the project's database: stores new ones and runs the consumers of the declared queues. */
export interface DatabaseQueue {
  /**
   * Inserts a `waiting` message, joining the current transaction, and wakes the queue's loop once it is committed; it
   * runs now with priority 0 unless `placement` says otherwise.
   */
  enqueue(name: string, payload: unknown, source: AddSource, placement?: MessagePlacement): Promise<QueueAddResult>;
  /** Starts one consumer loop per declared queue, and the reclaiming of expired leases. */
  start(repos: Repositories): void;
  /** Runs every loop at once, as an `add` in this process does for its queue. */
  wake(name: string): void;
  /** Returns the `active` messages whose lease passed to `waiting`; resolves with how many it returned. */
  reclaim(): Promise<number>;
  /** Stops claiming; running messages go on. */
  stop(): void;
  /**
   * Aborts the running handlers' signal, waits up to `graceMs` for them, and returns the ones still running to
   * `waiting` without counting their attempt.
   */
  drain(graceMs: number): Promise<void>;
  /** How many messages this process runs now, by queue. */
  running(): Record<string, number>;
  /**
   * Moves a `dead` message back to `waiting` with attempt 0, to run now; throws `Queue message <id> not found` or
   * `Queue message <id> is not dead`.
   */
  retry(id: string): Promise<void>;
  /** Moves every `dead` message of a queue back to `waiting`; resolves with how many. */
  retryDead(queue: string): Promise<number>;
  /** The latest `dead` messages of a queue, the most recently finished first. */
  dead(queue: string, options?: { limit?: number }): Promise<QueueMessage[]>;
  /** The counts of the declared queues and of every queue with messages that are not completed, by queue name. */
  stats(): Promise<Record<string, QueueStats>>;
  /**
   * Deletes completed and dead messages finished longer ago than their retention, in batches; resolves with how many
   * of each it deleted.
   */
  cleanup(): Promise<{ completed: number; dead: number }>;
}

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

/** Creates the database queue of one process. */
export function createDatabaseQueue(options: DatabaseQueueOptions): DatabaseQueue {
  const { adapter, model, definitions, logger, production, resultLimit } = options;
  const clock = options.clock ?? systemClock;
  const worker = options.worker ?? `${hostname()}:${process.pid}`;
  const pollMs = parseDuration(options.pollInterval) ?? 1000;
  const random = options.random ?? Math.random;
  const loops = new Map<string, Loop>();
  const runs = new Map<string, Running>();
  let repos: Repositories | undefined;
  let claiming = false;
  let stopReclaiming: (() => void) | undefined;
  let stopCleaning: (() => void) | undefined;

  const timestamp = () => new Date(clock.now()).toISOString();
  const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => safeLog(logger, level, { timestamp: timestamp(), message, ...fields });
  const timeoutOf = (name: string) => parseDuration(options.settings(name).timeout) ?? 300_000;

  const schedule = (loop: Loop, ms: number) => {
    clock.clearTimeout(loop.timer);
    loop.timer = clock.setTimeout(() => {
      loop.timer = undefined;
      void tick(loop);
    }, ms);
  };

  /** Claims a candidate with a conditional update; null when another worker claimed it first. */
  const claim = (row: StoredRecord): Promise<StoredRecord | null> => {
    const now = new Date(clock.now());
    const attempt = row.attempt as number;
    return adapter.updateById(
      model,
      row.id,
      { status: "active", attempt: attempt + 1, startedAt: now, worker, lockedUntil: new Date(now.getTime() + timeoutOf(row.queue as string)), updatedAt: now },
      [condition("status", "eq", "waiting"), condition("attempt", "eq", attempt)],
    );
  };

  /** Claims up to `count` due messages of a queue, trying the next candidate when another worker wins one. */
  const claimDue = async (name: string, count: number): Promise<QueueMessage[]> => {
    const now = new Date(clock.now());
    const { data } = await adapter.findMany(model, {
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
        const free = options.settings(loop.name).concurrency - loop.active;
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
      if (claiming) schedule(loop, pollMs);
    }
  };

  const wakeLoop = (loop: Loop | undefined) => {
    if (!loop || !claiming) return;
    clock.clearTimeout(loop.timer);
    loop.timer = undefined;
    void tick(loop);
  };

  /** Stores the outcome of a run, unless another process took the message over since. */
  const record = async (row: QueueMessage, outcome: Outcome, startedAt: number, jobLog: JobLogger) => {
    const now = new Date(clock.now());
    const durationMs = now.getTime() - startedAt;
    const fields = { queue: row.queue, messageId: row.id, attempt: row.attempt };
    const guard = [condition("status", "eq", "active"), condition("attempt", "eq", row.attempt)];
    if (outcome.kind === "interrupted") {
      // Not counted: the next worker runs the same attempt again.
      await adapter.updateById(model, row.id, { status: "waiting", attempt: row.attempt - 1, startedAt: null, worker: null, lockedUntil: null, updatedAt: now }, guard);
      log("warn", "queue.message.interrupted", fields);
      return;
    }
    if (outcome.kind === "completed") {
      const { result, note } = storableResult(outcome.value, resultLimit);
      if (note) jobLog.warn(note);
      // Without a dedupe window the key is free again once the message completed.
      const release = row.dedupeKey && !options.settings(row.queue).dedupeWindow ? { dedupeSlot: null } : {};
      await adapter.updateById(model, row.id, { status: "completed", finishedAt: now, lockedUntil: null, ...release, ...(result !== undefined ? { result: result as StoredRecord[string] } : {}), updatedAt: now }, guard);
      log("info", "queue.message.completed", { ...fields, durationMs });
      return;
    }
    const lastError = outcome.kind === "timedOut" ? { message: `Timed out after ${outcome.timeout}` } : runError(outcome.error, production);
    await fail(row, lastError, now, guard);
    log("warn", "queue.message.failed", { ...fields, durationMs, error: { message: lastError.message } });
  };

  /** How long a message waits before its next attempt: the doubled delay up to the longest, with a random jitter. */
  const retryDelayOf = (row: QueueMessage) => {
    const settings = options.settings(row.queue);
    const base = (parseDuration(settings.retryDelay) ?? 10_000) * 2 ** (row.attempt - 1);
    const capped = Math.min(base, parseDuration(settings.maxRetryDelay) ?? 3_600_000);
    return Math.max(0, Math.round(capped * (1 + (random() * 2 - 1) * RETRY_JITTER)));
  };

  /** The failure rule: back to `waiting` after a delay while attempts remain, `dead` after the last one. */
  const fail = async (row: QueueMessage, lastError: { message: string; stack?: string }, now: Date, guard: Condition[]) => {
    if (row.attempt < row.maxAttempts) {
      const runAt = new Date(now.getTime() + retryDelayOf(row));
      return adapter.updateById(model, row.id, { status: "waiting", runAt, lastError, lockedUntil: null, worker: null, updatedAt: now }, guard);
    }
    const dead = await adapter.updateById(model, row.id, { status: "dead", finishedAt: now, lastError, lockedUntil: null, dedupeSlot: null, updatedAt: now }, guard);
    if (dead) log("error", "queue.message.dead", { queue: row.queue, messageId: row.id, attempt: row.attempt, error: { message: lastError.message } });
    return dead;
  };

  /** Runs a claimed message in the background, waking its loop once it finished. */
  const begin = (loop: Loop, row: QueueMessage) => {
    loop.active++;
    const definition = definitions.get(row.queue);
    const controller = new AbortController();
    const timeoutMs = timeoutOf(row.queue);
    const startedAt = clock.now();
    const write = (level: "info" | "warn" | "error") => (message: string, fields?: JobLogFields) =>
      safeLog(logger, level, { timestamp: timestamp(), message: String(message), ...fields, queue: row.queue, messageId: row.id });
    const jobLog: JobLogger = { info: write("info"), warn: write("warn"), error: write("error") };
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
      adapter
        .updateById(model, row.id, { lockedUntil: new Date(now + timeoutMs), updatedAt: new Date(now) }, [condition("status", "eq", "active"), condition("attempt", "eq", row.attempt)])
        .catch(() => {});
    });
    // A message running longer than its timeout fails at once; its handler settling later changes nothing.
    const timeout = options.settings(row.queue).timeout;
    let timeoutHandle: unknown = clock.setTimeout(() => {
      timeoutHandle = undefined;
      controller.abort(timeoutReason(timeout));
      settle({ kind: "timedOut", timeout });
    }, timeoutMs);
    log("info", "queue.message.started", { queue: row.queue, messageId: row.id, attempt: row.attempt });
    const context: QueueContext = {
      payload: row.payload,
      repos: repos!,
      message: { id: row.id, queue: row.queue, attempt: row.attempt, enqueuedAt: new Date(row.enqueuedAt), ...(row.dedupeKey ? { dedupeKey: row.dedupeKey } : {}) },
      signal: controller.signal,
      log: jobLog,
      queue: queueClient(),
    };
    const run = () => {
      if (!definition) throw new Error(`No consumer is declared for the queue ${row.queue}`);
      return definition.handler(context);
    };
    Promise.resolve()
      .then(() => (operationContextEnabled() ? withOperation({ queue: { name: row.queue, messageId: row.id } }, run) : run()))
      .then(
        (value) => settle({ kind: "completed", value }),
        (error: unknown) => settle({ kind: "failed", error }),
      );
    const done = outcome.promise
      .then((result) => {
        stopLease();
        clock.clearTimeout(timeoutHandle);
        return record(row, result, startedAt, jobLog);
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
      const now = new Date(clock.now());
      const { data } = await adapter.findMany(model, {
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
            ? await fail(message, { message: `Lease expired after ${options.settings(message.queue).timeout}` }, now, guard)
            : await adapter.updateById(model, row.id, { status: "waiting", worker: null, lockedUntil: null, updatedAt: now }, guard);
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
    const now = new Date(clock.now());
    const key = row.dedupeKey as string | null | undefined;
    const slot = key ? slotOf(row.queue as string, key) : undefined;
    const inUse = (holder: StoredRecord) => new Error(`Queue message ${row.id} has dedupe key ${key} in use by ${holder.id}`);
    if (slot) {
      // The key goes back to the message, unless a newer message holds it.
      const holder = await adapter.findOne(model, [condition("dedupeSlot", "eq", slot)]);
      if (holder && holder.id !== row.id) {
        if (deduplicates(holder, now)) throw inUse(holder);
        await release(holder, slot, now);
      }
    }
    let requeued: StoredRecord | null;
    try {
      requeued = await adapter.updateById(
        model,
        row.id,
        { status: "waiting", attempt: 0, runAt: now, finishedAt: null, startedAt: null, lockedUntil: null, worker: null, ...(slot ? { dedupeSlot: slot } : {}), updatedAt: now },
        [condition("status", "eq", "dead")],
      );
    } catch (error) {
      if (!(error instanceof UniqueViolationError) || !slot) throw error;
      const holder = await adapter.findOne(model, [condition("dedupeSlot", "eq", slot)]);
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
      const { data } = await adapter.findMany(model, { where: [...where, ...(after ? [condition("id", "gt", after)] : [])], sort: [{ field: "id", direction: "asc" }], limit: 1000, offset: 0, withTotal: false });
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
      const { data } = await adapter.findMany(model, {
        where: [condition("status", "eq", status), condition("finishedAt", "lt", cutoff), ...(after ? [condition("id", "gt", after)] : [])],
        sort: [{ field: "id", direction: "asc" }],
        limit: CLEANUP_BATCH,
        offset: 0,
        withTotal: false,
      });
      for (const row of data) if (await adapter.deleteById(model, row.id)) deleted++;
      if (data.length < CLEANUP_BATCH) return deleted;
      after = data.at(-1)!.id;
    }
  };

  const cleanup = async () => {
    const now = clock.now();
    const retention = options.retention ?? { completed: "7d", dead: "30d" };
    const completed = await deleteFinished("completed", new Date(now - (parseDuration(retention.completed) ?? 7 * 86_400_000)));
    const dead = await deleteFinished("dead", new Date(now - (parseDuration(retention.dead) ?? 30 * 86_400_000)));
    log("info", "queue.cleanup", { completed, dead });
    return { completed, dead };
  };

  const cleanupSafely = () =>
    void cleanup().catch((error: unknown) => log("error", "queue.cleanup.failed", { error: { message: (error as Error)?.message ?? String(error) } }));

  /** Inserts a message unless another one holds its dedupe slot; resolves null then. */
  const insertOrSkip = async (row: StoredRecord): Promise<StoredRecord | null> => {
    if (adapter.insertOrSkip) return adapter.insertOrSkip(model, row, "dedupeSlot");
    try {
      return await adapter.insert(model, row);
    } catch (error) {
      if (error instanceof UniqueViolationError) return null;
      throw error;
    }
  };

  /** Whether a message holding a dedupe slot still deduplicates its key: while it is live, or completed within the window. */
  const deduplicates = (holder: StoredRecord, now: Date): boolean => {
    if (holder.status === "waiting" || holder.status === "active") return true;
    if (holder.status !== "completed" || !holder.finishedAt) return false;
    const window = parseDuration(options.settings(holder.queue as string).dedupeWindow);
    return window !== undefined && new Date(holder.finishedAt as Date).getTime() >= now.getTime() - window;
  };

  /** Frees the slot of a message that no longer deduplicates, unless it changed since it was read. */
  const release = (holder: StoredRecord, slot: string, now: Date) =>
    adapter.updateById(model, holder.id, { dedupeSlot: null, updatedAt: now }, [condition("dedupeSlot", "eq", slot), condition("status", "eq", holder.status)]);

  const stop = () => {
    claiming = false;
    stopReclaiming?.();
    stopReclaiming = undefined;
    stopCleaning?.();
    stopCleaning = undefined;
    for (const loop of loops.values()) {
      clock.clearTimeout(loop.timer);
      loop.timer = undefined;
    }
  };

  return {
    async enqueue(name, payload, source, placement) {
      const now = new Date(clock.now());
      const { runAt, priority, dedupeKey } = placement ?? { runAt: now, priority: 0 };
      const settings = options.settings(name);
      const row: StoredRecord = {
        id: Bun.randomUUIDv7(),
        createdAt: now,
        updatedAt: now,
        queue: name,
        payload: payload as StoredRecord[string],
        status: "waiting",
        priority,
        runAt,
        attempt: 0,
        maxAttempts: settings.retries + 1,
        enqueuedAt: now,
        ...(source.requestId ? { requestId: source.requestId } : {}),
      };
      const wake = () => void afterCommit(() => wakeLoop(loops.get(name)));
      if (dedupeKey === undefined) {
        // Inside a transaction the insert joins it, so the message exists only once the transaction commits.
        await adapter.insert(model, row);
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
        const holder = await adapter.findOne(model, [condition("dedupeSlot", "eq", slot)]);
        if (!holder) continue;
        if (deduplicates(holder, now)) {
          log("info", "queue.message.deduplicated", { queue: name, dedupeKey, messageId: holder.id });
          return { id: holder.id, deduplicated: true };
        }
        await release(holder, slot, now);
      }
      throw new Error(`Queue message for ${name} with dedupe key ${dedupeKey} could not be added; try again`);
    },
    start(startRepos) {
      if (claiming) return;
      repos = startRepos;
      claiming = true;
      for (const name of definitions.keys()) {
        const loop: Loop = { name, active: 0, ticking: false, again: false };
        loops.set(name, loop);
        wakeLoop(loop);
      }
      reclaimSafely();
      stopReclaiming = repeat(clock, RECLAIM_INTERVAL, reclaimSafely);
      cleanupSafely();
      stopCleaning = repeat(clock, CLEANUP_INTERVAL, cleanupSafely);
    },
    wake(name) {
      wakeLoop(loops.get(name));
    },
    reclaim,
    stop,
    async drain(graceMs) {
      // A service whose startup failed stops without a shutdown, so draining also stops claiming.
      stop();
      const current = [...runs.values()];
      for (const entry of current) entry.controller.abort(shutdownReason());
      let timer: unknown;
      await Promise.race([Promise.allSettled(current.map((entry) => entry.done)), new Promise<void>((resolve) => (timer = clock.setTimeout(resolve, graceMs)))]);
      clock.clearTimeout(timer);
      // The handlers still running give their message back without counting the attempt.
      for (const entry of [...runs.values()]) entry.settle({ kind: "interrupted" });
      await Promise.allSettled(current.map((entry) => entry.done));
    },
    running() {
      return Object.fromEntries([...loops.values()].map((loop) => [loop.name, loop.active]));
    },
    async retry(id) {
      const row = await adapter.findById(model, id);
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
      const { data } = await adapter.findMany(model, {
        where: [condition("queue", "eq", queue), condition("status", "eq", "dead")],
        sort: [{ field: "finishedAt", direction: "desc" }, { field: "id", direction: "desc" }],
        limit: Math.max(1, Math.floor(limit)),
        offset: 0,
        withTotal: false,
      });
      return data as unknown as QueueMessage[];
    },
    async stats() {
      const names = new Set(definitions.keys());
      for (const row of await rowsWhere([{ field: "status", op: "in", value: ["waiting", "active", "dead"] } as Condition])) names.add(row.queue as string);
      const stats: Record<string, QueueStats> = {};
      for (const name of [...names].sort()) {
        const counts = await adapter.aggregate(model, [condition("queue", "eq", name)], {
          waiting: { fn: "count", where: [condition("status", "eq", "waiting")] },
          active: { fn: "count", where: [condition("status", "eq", "active")] },
          completed: { fn: "count", where: [condition("status", "eq", "completed")] },
          dead: { fn: "count", where: [condition("status", "eq", "dead")] },
        });
        const { oldest } = await adapter.aggregate(model, [condition("queue", "eq", name), condition("status", "eq", "waiting")], { oldest: { fn: "min", field: "enqueuedAt" } });
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
  };
}
