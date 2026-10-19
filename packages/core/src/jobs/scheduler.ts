import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "../adapter.ts";
import type { ResolvedConfig } from "../config.ts";
import { parseSize } from "../files/limits.ts";
import type { Repositories } from "../hooks.ts";
import { safeLog, type Logger } from "../logger.ts";
import type { EntityModel } from "../model.ts";
import { jobSettings, type JobContext, type JobDefinition, type JobLogFields, type JobLogger, type JobSettings, type JobTrigger } from "./job.ts";
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
}

/** Identifies the run to claim: one record per job, scheduled time and attempt. */
export interface RunRequest {
  job: string;
  trigger: JobTrigger;
  scheduledAt: Date;
  attempt: number;
  /** Runs even when the job is already running and its overlap is `skip`. */
  force?: boolean;
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
  /** The runs this instance is executing, by run id. */
  readonly active: ReadonlyMap<string, ActiveRun>;
  /** Resolves when every claim and execution started so far has finished. */
  idle(): Promise<void>;
}

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
    safeLog(logger, run.status === "failed" ? "error" : "info", {
      timestamp: timestamp(),
      message,
      job: run.job,
      runId: run.id,
      status: run.status,
      ...(message === "job.finished" ? { durationMs: run.durationMs ?? 0 } : {}),
    });
  };

  const claim = (request: RunRequest): Promise<JobRun | null> =>
    track(
      (async () => {
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

  const execute = (run: JobRun): Promise<JobRun> => {
    const definition = definitionOf(run.job);
    const controller = new AbortController();
    const logs = createLogCollector(config.limits.logLines, clock.now);
    const write = (level: JobRunLog["level"]) => (message: string, fields?: JobLogFields) => {
      const stored = jsonFields(fields);
      logs.add({ level, message: String(message), at: timestamp(), ...(stored ? { fields: stored } : {}) });
      safeLog(logger, level, { timestamp: timestamp(), message: String(message), ...fields, job: run.job, runId: run.id });
    };
    const log: JobLogger = { info: write("info"), warn: write("warn"), error: write("error") };
    const context: JobContext = {
      repos,
      files,
      signal: controller.signal,
      log,
      run: { id: run.id, job: run.job, scheduledAt: run.scheduledAt, attempt: run.attempt, trigger: run.trigger },
    };
    const done = (async (): Promise<JobRun> => {
      logEvent("job.started", run);
      let changes: Partial<JobRun>;
      try {
        const value = await Promise.resolve().then(() => definition.run(context));
        const { result, note } = storableResult(value, config.limits.result);
        if (note) log.warn(note);
        changes = { status: "success", ...(result !== undefined ? { result } : {}) };
      } catch (error) {
        changes = { status: "failed", error: runError(error, production) };
      }
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
      return finished;
    })();
    active.set(run.id, { run, controller, done });
    const forget = () => active.delete(run.id);
    done.then(forget, forget);
    return track(done);
  };

  return {
    settingsOf,
    claim,
    execute,
    run(request) {
      return track(
        (async () => {
          const claimed = await claim(request);
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
