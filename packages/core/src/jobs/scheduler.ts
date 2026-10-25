import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "../adapter.ts";
import { withJobOperation } from "../operation-context.ts";
import { queueClient } from "../features/queues/client.ts";
import type { ResolvedConfig } from "../config.ts";
import { parseSize } from "../files/limits.ts";
import type { Repositories } from "../hooks.ts";
import { safeLog, type LogMasker, type Logger } from "../logger.ts";
import type { EntityModel } from "../model.ts";
import { retryDelayOf, startTimer, timeoutError } from "./attempts.ts";
import { heartbeatInterval, isAbandoned, shutdownError, SHUTDOWN_MESSAGE, startRepeating } from "./lifecycle.ts";
import { jobSettings, parseDuration, type JobContext, type JobDefinition, type JobLogFields, type JobLogger, type JobSettings, type JobTrigger } from "./job.ts";
import { jobRunEntity, type JobRun, type JobRunLog } from "./job-run.ts";
import { nextRunTime, parseSchedule, type ParsedSchedule } from "./schedule.ts";

/** The time source and timers the job scheduler uses; tests pass a fake one. */
export interface JobClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: JobClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Longest delay a single timer accepts; longer waits are chained. */
export const MAX_TIMER_DELAY = 2_147_483_647;

export interface JobRunnerOptions {
  /** The job registry: job name to definition. */
  jobs: ReadonlyMap<string, JobDefinition>;
  /** The connected database the run records are written to. */
  database: DatabaseAdapter;
  /** The `JobRun` model the database was connected with (default: the built-in one). */
  model?: EntityModel;
  /** The repositories passed to the job closures. */
  repos: Repositories;
  /** The file storages passed to the job closures. */
  files: JobContext["files"];
  /** The resolved `jobs` config. */
  config: ResolvedConfig["jobs"];
  /** Hides error stacks in run records. */
  production: boolean;
  logger: Logger;
  clock?: JobClock;
  /** Masks the log lines, result and error of each run before they are stored. */
  mask?: LogMasker;
}

/** Identifies the run to claim: one record per job, scheduled time and attempt. */
export interface RunRequest {
  job: string;
  trigger: JobTrigger;
  scheduledAt: Date;
  attempt: number;
  /** Runs even when the job is already running and its overlap is `skip`. */
  force?: boolean;
  /** Called by `run()` with the claimed record, before it is executed. */
  onClaimed?: (run: JobRun) => void;
}

/** A run being executed in this instance. */
export interface ActiveRun {
  run: JobRun;
  controller: AbortController;
  /** Resolves with the final record once the outcome is stored. */
  done: Promise<JobRun>;
}

export interface JobRunner {
  /** The job's options applied over the `jobs` config defaults; throws `Unknown job <name>` for a name not in the registry. */
  settingsOf(name: string): JobSettings;
  /**
   * Inserts the run record. Returns null when another instance already holds that job, scheduled time and attempt.
   * The record is stored as `skipped` when the job's overlap is `skip` and it already has a running run.
   */
  claim(request: RunRequest): Promise<JobRun | null>;
  /** Runs the job of a claimed `running` record and stores its outcome. */
  execute(run: JobRun): Promise<JobRun>;
  /** Claims a run and, when this instance holds it and it is not skipped, executes it. */
  run(request: RunRequest): Promise<JobRun | null>;
  /**
   * Schedules the next attempt of a finished run when its status is retried and attempts remain: after
   * `retryDelay × 2^(attempt − 1)`, claimed like any other run. Runs executed here are retried on their own.
   */
  retry(run: JobRun): void;
  /**
   * Marks as `abandoned` the `running` records, of any instance, without a heartbeat (or, without one, since they
   * started) for longer than their job's timeout, and retries them. Only records still `running` are updated, so a
   * record is marked once even when several instances check at the same time. Resolves with the records it marked.
   */
  markAbandoned(): Promise<JobRun[]>;
  /**
   * Stops claiming runs (`claim()` and `run()` then reject) and retrying, aborts the signal of every running run, waits up to `graceMs` for them, and
   * records the ones still running as `interrupted`.
   */
  shutdown(graceMs: number): Promise<void>;
  /** The runs this instance is executing, by run id. */
  readonly active: ReadonlyMap<string, ActiveRun>;
  /** Resolves when every claim and execution started so far has finished, including the retries they scheduled. */
  idle(): Promise<void>;
}

/** Why a run cannot be claimed once the runner is shutting down. */
export const SHUTTING_DOWN = "Job runs are not started while the server shuts down";

const condition = (field: string, value: unknown) => ({ field, op: "eq" as const, value });

/** The JSON form of a closure's return value, or the reason it is not stored. */
export function storableResult(value: unknown, limit: number | string): { result?: unknown; note?: string } {
  if (value === undefined) return {};
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) return { note: "Result is not JSON-serializable" };
  const maxBytes = parseSize(limit) ?? Number.POSITIVE_INFINITY;
  if (Buffer.byteLength(json) > maxBytes) {
    return { note: `Result larger than ${typeof limit === "number" ? `${limit} bytes` : limit} was not stored` };
  }
  return { result: JSON.parse(json) as unknown };
}

/** The stored form of a thrown value; the stack is left out in production. */
export function runError(error: unknown, production: boolean): { message: string; stack?: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  return production || error.stack === undefined ? { message: error.message } : { message: error.message, stack: error.stack };
}

function jsonFields(fields: JobLogFields | undefined): JobLogFields | undefined {
  if (fields === undefined) return undefined;
  try {
    const copy = JSON.parse(JSON.stringify(fields)) as unknown;
    return copy && typeof copy === "object" && !Array.isArray(copy) ? (copy as JobLogFields) : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps at most `limit` log lines: past the limit, the first `limit - 1` lines and a line counting the rest. */
export function createLogCollector(limit: number, now: () => number) {
  const kept: JobRunLog[] = [];
  let total = 0;
  return {
    add(line: JobRunLog): void {
      total++;
      if (kept.length < limit) kept.push(line);
    },
    lines(): JobRunLog[] {
      if (total <= limit) return [...kept];
      const shown = kept.slice(0, Math.max(limit - 1, 0));
      return [...shown, { level: "info", message: `${total - shown.length} more lines omitted`, at: new Date(now()).toISOString() }];
    },
  };
}

/** Claims, executes and records job runs; scheduled, retried and on-demand runs all go through it. */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { jobs, database, repos, files, config, production, logger } = options;
  const masked = <T>(value: T): T => (options.mask ? options.mask.entry(value) : value);
  const model = options.model ?? jobRunEntity();
  const clock = options.clock ?? systemClock;
  const active = new Map<string, ActiveRun>();
  const pending = new Set<Promise<unknown>>();
  const timestamp = () => new Date(clock.now()).toISOString();

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    const forget = () => pending.delete(promise);
    promise.then(forget, forget);
    return promise;
  };

  const definitionOf = (name: string): JobDefinition => {
    const definition = jobs.get(name);
    if (!definition) throw new Error(`Unknown job ${name}`);
    return definition;
  };

  const settingsOf = (name: string): JobSettings => jobSettings(definitionOf(name).options, config);

  const logEvent = (message: "job.started" | "job.finished", run: JobRun) => {
    safeLog(logger, run.status === "failed" || run.status === "timedOut" ? "error" : "info", {
      timestamp: timestamp(),
      message,
      job: run.job,
      runId: run.id,
      status: run.status,
      ...(message === "job.finished" ? { durationMs: run.durationMs ?? 0 } : {}),
    });
  };

  let closed = false;
  /** Ends a run of this instance with the given outcome, unless it already has one. */
  const interrupters = new Map<string, (changes: Partial<JobRun>) => void>();

  const claim = (request: RunRequest): Promise<JobRun | null> =>
    track(
      (async () => {
        if (closed) throw new Error(SHUTTING_DOWN);
        const settings = settingsOf(request.job);
        const overlapping =
          settings.overlap === "skip" &&
          !request.force &&
          (await database.findOne(model, [condition("job", request.job), condition("status", "running")])) !== null;
        const now = new Date(clock.now());
        const record: StoredRecord = {
          id: Bun.randomUUIDv7(),
          createdAt: now,
          updatedAt: now,
          job: request.job,
          trigger: request.trigger,
          scheduledAt: request.scheduledAt,
          attempt: request.attempt,
          status: overlapping ? "skipped" : "running",
          startedAt: now,
          ...(overlapping ? { finishedAt: now, durationMs: 0 } : {}),
          logs: [],
        };
        try {
          await database.insert(model, record);
        } catch (error) {
          if (error instanceof UniqueViolationError) return null;
          throw error;
        }
        const run = record as unknown as JobRun;
        if (overlapping) {
          logEvent("job.started", run);
          logEvent("job.finished", run);
        }
        return run;
      })(),
    );

  const retryTimers = new Set<() => void>();

  const retry = (finished: JobRun): void => {
    const delay = retryDelayOf(finished, settingsOf(finished.job));
    const request: RunRequest = { job: finished.job, trigger: finished.trigger, scheduledAt: finished.scheduledAt, attempt: finished.attempt + 1 };
    if (delay === undefined || closed) return;
    // Tracked from now on, so `idle()` also waits for the attempts still to come.
    const { promise, resolve } = Promise.withResolvers<void>();
    const stopTimer = startTimer(clock, delay, () => {
      retryTimers.delete(cancel);
      runner
        .run(request)
        .catch((error: unknown) => {
          safeLog(logger, "error", {
            timestamp: timestamp(),
            message: "job.error",
            job: request.job,
            scheduledAt: request.scheduledAt.toISOString(),
            attempt: request.attempt,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(resolve);
    });
    const cancel = () => {
      stopTimer();
      resolve();
    };
    retryTimers.add(cancel);
    void track(promise);
  };

  const execute = (run: JobRun): Promise<JobRun> => {
    const definition = definitionOf(run.job);
    const { timeout } = settingsOf(run.job);
    const timeoutMs = parseDuration(timeout);
    const controller = new AbortController();
    const logs = createLogCollector(config.limits.logLines, clock.now);
    const write = (level: JobRunLog["level"]) => (message: string, fields?: JobLogFields) => {
      const stored = jsonFields(fields);
      logs.add(masked({ level, message: String(message), at: timestamp(), ...(stored ? { fields: stored } : {}) }));
      safeLog(logger, level, { timestamp: timestamp(), message: String(message), ...fields, job: run.job, runId: run.id });
    };
    const log: JobLogger = { info: write("info"), warn: write("warn"), error: write("error") };
    const context: JobContext = {
      repos,
      files,
      signal: controller.signal,
      log,
      run: { id: run.id, job: run.job, scheduledAt: run.scheduledAt, attempt: run.attempt, trigger: run.trigger },
      queue: queueClient(),
    };
    const done = (async (): Promise<JobRun> => {
      logEvent("job.started", run);
      // The first outcome wins: once the run timed out or was interrupted, the closure settling later changes nothing.
      let settled = false;
      const changes = await new Promise<Partial<JobRun>>((resolve) => {
        const stops: (() => void)[] = [];
        const settle = (outcome: Partial<JobRun>) => {
          if (settled) return;
          settled = true;
          for (const stop of stops) stop();
          interrupters.delete(run.id);
          resolve(outcome);
        };
        if (timeoutMs !== undefined) {
          stops.push(
            startRepeating(clock, heartbeatInterval(timeoutMs), () => {
              const heartbeatAt = new Date(clock.now());
              database.updateById(model, run.id, { heartbeatAt, updatedAt: heartbeatAt }, [condition("status", "running")]).catch(() => {});
            }),
            startTimer(clock, timeoutMs, () => {
              const reason = timeoutError(timeout);
              controller.abort(reason);
              settle({ status: "timedOut", error: { message: reason.message } });
            }),
          );
        }
        interrupters.set(run.id, settle);
        Promise.resolve()
          .then(() => withJobOperation({ name: run.job, runId: run.id }, () => definition.run(context)))
          .then(
            (value) => {
              if (settled) return;
              const { result, note } = storableResult(value, config.limits.result);
              if (note) log.warn(note);
              settle({ status: "success", ...(result !== undefined ? { result: masked(result) } : {}) });
            },
            (error: unknown) => settle({ status: "failed", error: masked(runError(error, production)) }),
          );
      });
      const finishedAt = new Date(clock.now());
      Object.assign(changes, {
        finishedAt,
        durationMs: Math.max(finishedAt.getTime() - run.startedAt.getTime(), 0),
        logs: logs.lines(),
        updatedAt: finishedAt,
      });
      await database.updateById(model, run.id, changes);
      const finished = { ...run, ...changes } as JobRun;
      logEvent("job.finished", finished);
      retry(finished);
      return finished;
    })();
    active.set(run.id, { run, controller, done });
    if (closed) controller.abort(shutdownError());
    const forget = () => active.delete(run.id);
    done.then(forget, forget);
    return track(done);
  };

  const markAbandoned = (): Promise<JobRun[]> =>
    track(
      (async () => {
        if (closed) return [];
        const { data } = await database.findMany(model, {
          where: [condition("status", "running")],
          sort: [{ field: "startedAt", direction: "asc" }],
          limit: 1000,
          offset: 0,
          withTotal: false,
        });
        const marked: JobRun[] = [];
        for (const record of data as unknown as JobRun[]) {
          if (active.has(record.id)) continue;
          const known = jobs.has(record.job);
          const timeout = known ? settingsOf(record.job).timeout : config.timeout;
          const timeoutMs = parseDuration(timeout);
          if (timeoutMs === undefined || !isAbandoned(record, timeoutMs, clock.now())) continue;
          const finishedAt = new Date(clock.now());
          const changes = { status: "abandoned" as const, finishedAt, updatedAt: finishedAt, error: { message: `No heartbeat for ${timeout}` } };
          if (!(await database.updateById(model, record.id, changes, [condition("status", "running")]))) continue;
          const abandoned: JobRun = { ...record, ...changes };
          marked.push(abandoned);
          if (known) retry(abandoned);
        }
        return marked;
      })(),
    );

  const shutdown = async (graceMs: number): Promise<void> => {
    closed = true;
    for (const cancel of retryTimers) cancel();
    retryTimers.clear();
    const running = () => [...active.values()];
    for (const { controller } of running()) controller.abort(shutdownError());
    if (active.size > 0) {
      let stopWaiting = () => {};
      const grace = new Promise<void>((resolve) => (stopWaiting = startTimer(clock, graceMs, resolve)));
      await Promise.race([Promise.allSettled(running().map(({ done }) => done)), grace]);
      stopWaiting();
    }
    for (const interrupt of [...interrupters.values()]) interrupt({ status: "interrupted", error: { message: SHUTDOWN_MESSAGE } });
    await Promise.allSettled(running().map(({ done }) => done));
  };

  const runner: JobRunner = {
    settingsOf,
    claim,
    execute,
    retry,
    markAbandoned,
    shutdown,
    run(request) {
      return track(
        (async () => {
          const claimed = await claim(request);
          if (claimed) request.onClaimed?.(claimed);
          if (!claimed || claimed.status !== "running") return claimed;
          return execute(claimed);
        })(),
      );
    },
    active,
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
  return runner;
}

export interface JobSchedulerOptions {
  /** Schedules nothing when false (`jobs.enabled`). */
  enabled: boolean;
  logger: Logger;
  clock?: JobClock;
}

export interface JobScheduler {
  /** Arms every job at its next run time; a no-op when jobs are disabled or the registry is empty. */
  start(): void;
  /** Stops scheduling new runs; runs already started keep going. */
  stop(): void;
  /** The next run time this instance is waiting for, by job name. */
  readonly nextRuns: ReadonlyMap<string, Date>;
  /** Resolves when every run started so far has finished. */
  idle(): Promise<void>;
}

/** Runs each job of the registry at its scheduled times, claiming every run through the run records. */
export function createJobScheduler(jobs: ReadonlyMap<string, JobDefinition>, runner: JobRunner, options: JobSchedulerOptions): JobScheduler {
  const clock = options.clock ?? systemClock;
  const timers = new Map<string, unknown>();
  const nextRuns = new Map<string, Date>();
  let started = false;

  const tick = (name: string, scheduledAt: Date) => {
    runner.run({ job: name, trigger: "schedule", scheduledAt, attempt: 1 }).catch((error: unknown) => {
      safeLog(options.logger, "error", {
        timestamp: new Date(clock.now()).toISOString(),
        message: "job.error",
        job: name,
        scheduledAt: scheduledAt.toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const arm = (name: string, schedule: ParsedSchedule, timeZone: string, at: Date) => {
    nextRuns.set(name, at);
    const delay = Math.min(Math.max(at.getTime() - clock.now(), 0), MAX_TIMER_DELAY);
    timers.set(
      name,
      clock.setTimeout(() => {
        if (!started) return;
        if (clock.now() < at.getTime()) return arm(name, schedule, timeZone, at);
        plan(name, schedule, timeZone, Math.max(at.getTime(), clock.now()));
        tick(name, at);
      }, delay),
    );
  };

  const plan = (name: string, schedule: ParsedSchedule, timeZone: string, after: number) => {
    const next = nextRunTime(schedule, timeZone, new Date(after));
    timers.delete(name);
    nextRuns.delete(name);
    if (next) arm(name, schedule, timeZone, next);
  };

  return {
    start() {
      if (started || !options.enabled) return;
      started = true;
      for (const [name, definition] of jobs) {
        plan(name, parseSchedule(definition.schedule), runner.settingsOf(name).timeZone, clock.now());
      }
    },
    stop() {
      started = false;
      for (const handle of timers.values()) clock.clearTimeout(handle);
      timers.clear();
      nextRuns.clear();
    },
    nextRuns,
    idle: () => runner.idle(),
  };
}
