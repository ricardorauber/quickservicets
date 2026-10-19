import type { DatabaseAdapter } from "../adapter.ts";
import { memoryAdapter } from "../adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "../config.ts";
import type { LogEntry, Logger } from "../logger.ts";
import type { JobDefinition } from "./job.ts";
import { jobRunEntity, type JobRun } from "./job-run.ts";
import { createJobRunner, createJobScheduler, type JobClock } from "./scheduler.ts";

/** Helpers shared by the job tests. */

export const START = Date.parse("2026-10-19T10:00:00.250Z");
export const jobRunModel = jobRunEntity();

export type FakeClock = ReturnType<typeof fakeClock>;

/** A clock whose timers fire only when the test advances it. */
export function fakeClock(start = START) {
  let now = start;
  let sequence = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const clock = {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++sequence;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    sleep: (ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, ms)),
    timers: () => timers.size,
    flush,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
      await flush();
    },
  } satisfies JobClock & Record<string, unknown>;
  return clock;
}

export function captureLogger() {
  const entries: (LogEntry & { level: string })[] = [];
  const logger: Logger = {
    info: (entry) => entries.push({ level: "info", ...entry }),
    warn: (entry) => entries.push({ level: "warn", ...entry }),
    error: (entry) => entries.push({ level: "error", ...entry }),
  };
  return { logger, entries };
}

export async function connectedMemory(): Promise<DatabaseAdapter> {
  const database = memoryAdapter();
  await database.connect([jobRunModel]);
  return database;
}

export interface InstanceSetup {
  clock?: JobClock;
  config?: Partial<ServiceConfig>;
  env?: Record<string, string>;
}

/** A job runner and scheduler over `database`, as one server instance would have them. */
export function jobInstance(jobs: Record<string, JobDefinition>, database: DatabaseAdapter, setup: InstanceSetup = {}) {
  const clock = setup.clock ?? fakeClock();
  const { logger, entries } = captureLogger();
  const config = resolveConfig({ database, logger, ...setup.config }, setup.env ?? {});
  const registry = new Map(Object.entries(jobs));
  const runner = createJobRunner({
    jobs: registry,
    database,
    repos: {} as never,
    files: config.storage,
    config: config.jobs,
    production: config.production,
    logger,
    clock,
  });
  const scheduler = createJobScheduler(registry, runner, { enabled: config.jobs.enabled, logger, clock });
  return { clock, config, runner, scheduler, entries, logger };
}

/** Every run record, by scheduled time and attempt. */
export async function jobRunRecords(database: DatabaseAdapter): Promise<JobRun[]> {
  const { data } = await database.findMany(jobRunModel, {
    where: [],
    sort: [
      { field: "scheduledAt", direction: "asc" },
      { field: "attempt", direction: "asc" },
    ],
    limit: 1000,
    offset: 0,
  });
  return data as unknown as JobRun[];
}
