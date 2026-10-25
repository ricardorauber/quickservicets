import { hostname } from "node:os";
import {
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
}

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
      await adapter.updateById(model, row.id, { status: "completed", finishedAt: now, lockedUntil: null, ...(result !== undefined ? { result: result as StoredRecord[string] } : {}), updatedAt: now }, guard);
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
    return adapter.updateById(model, row.id, { status: "dead", finishedAt: now, lastError, lockedUntil: null, updatedAt: now }, guard);
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

  const stop = () => {
    claiming = false;
    stopReclaiming?.();
    stopReclaiming = undefined;
    for (const loop of loops.values()) {
      clock.clearTimeout(loop.timer);
      loop.timer = undefined;
    }
  };

  return {
    async enqueue(name, payload, source, placement) {
      const now = new Date(clock.now());
      const { runAt, priority } = placement ?? { runAt: now, priority: 0 };
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
      // Inside a transaction the insert joins it, so the message exists only once the transaction commits.
      await adapter.insert(model, row);
      void afterCommit(() => wakeLoop(loops.get(name)));
      return { id: row.id, deduplicated: false };
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
  };
}
