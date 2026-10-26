import type { Repositories } from "../hooks.ts";
import type { StorageAdapter } from "../storage/storage.ts";
import type { QueueClient } from "../features/queues/queue.ts";
import type { Schedule } from "./schedule.ts";

/**
 * When a job runs: a cron string (5 fields, or 6 with seconds first), a preset (`@yearly`, `@monthly`, `@weekly`,
 * `@daily`, `@hourly`), an interval (`{ every: "10m" }`, units `s`, `m`, `h`, `d`, at least `1s`) or a single
 * ISO 8601 date-time with an offset (`{ at: "2026-12-01T09:00:00Z" }`).
 */
export type JobSchedule = Schedule;

/** Per-job settings; each one overrides the matching `jobs` config default. */
export interface JobOptions {
  /** How many times a failed run is retried (integer, at least 0). */
  retries?: number;
  /** Delay before the first retry, doubled for each next one, as a duration like `30s`. */
  retryDelay?: string;
  /** Longest a run may last, as a duration like `5m`. */
  timeout?: string;
  /** How long run records are kept, as a duration like `30d`. */
  retention?: string;
  /** IANA time zone the cron schedule is evaluated in, like `America/Sao_Paulo`. */
  timeZone?: string;
  /** What a run does while the previous one is still running: `skip` it or run in `parallel`. */
  overlap?: "skip" | "parallel";
}

/** What started a run: its schedule, the CLI, or application code. */
export type JobTrigger = "schedule" | "manual" | "code";

/** The run being executed. */
export interface JobRunInfo {
  /** The id of the run record. */
  id: string;
  /** The job name, its path under `jobs/` without extension. */
  job: string;
  /** The run time this run belongs to. */
  scheduledAt: Date;
  /** The attempt number, starting at 1. */
  attempt: number;
  trigger: JobTrigger;
}

export type JobLogFields = Record<string, unknown>;

/** Writes to the service logger and to the run record. */
export interface JobLogger {
  info(message: string, fields?: JobLogFields): void;
  warn(message: string, fields?: JobLogFields): void;
  error(message: string, fields?: JobLogFields): void;
}

/** What a job closure receives. */
export interface JobContext {
  /** The typed repositories. */
  repos: Repositories;
  /** The configured file storages. */
  files: Record<string, StorageAdapter> & { default: StorageAdapter };
  /** Aborted when the run times out or the server shuts down. */
  signal: AbortSignal;
  log: JobLogger;
  run: JobRunInfo;
  /** Adds messages to the project's queues; throws while the `queues` native is not enabled. */
  queue: QueueClient;
}

export type JobFn = (ctx: JobContext) => unknown | Promise<unknown>;

const JOB_MARKER = Symbol.for("quickservicets.job");

/** A job declared with `job(...)`, default-exported by a file in `jobs/`. */
export interface JobDefinition {
  readonly [JOB_MARKER]: true;
  schedule: JobSchedule;
  run: JobFn;
  options: JobOptions;
  /** The key of the feature whose folder holds the job; it does not run while that feature is disabled. */
  feature?: string;
}

/** Declares a scheduled job. The default export of each file in `jobs/` must be one. */
export function job(schedule: JobSchedule, run: JobFn, options: JobOptions = {}): JobDefinition {
  return { [JOB_MARKER]: true, schedule, run, options };
}

export function isJobDefinition(value: unknown): value is JobDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[JOB_MARKER] === true;
}

/** Milliseconds per duration unit. */
export const DURATION_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const DURATION = /^(\d+)([a-z]+)$/;

/** A duration like `30s`, `10m`, `2h` or `30d` in milliseconds, or undefined when it is not one. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = DURATION.exec(value);
  if (!match || !Object.hasOwn(DURATION_UNITS, match[2]!)) return undefined;
  return Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS];
}

/** The settings a job runs with: its own options, else the `jobs` config defaults. */
export type JobSettings = Required<JobOptions>;

/** Applies a job's options over the `jobs` config defaults. */
export function jobSettings(
  options: JobOptions,
  defaults: Pick<JobSettings, "retries" | "retryDelay" | "timeout" | "retention" | "timeZone">,
): JobSettings {
  return {
    retries: options.retries ?? defaults.retries,
    retryDelay: options.retryDelay ?? defaults.retryDelay,
    timeout: options.timeout ?? defaults.timeout,
    retention: options.retention ?? defaults.retention,
    timeZone: options.timeZone ?? defaults.timeZone,
    overlap: options.overlap ?? "skip",
  };
}
