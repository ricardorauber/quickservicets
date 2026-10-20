import type { DatabaseAdapter } from "../adapter.ts";
import type { ResolvedConfig } from "../config.ts";
import { safeLog, type Logger } from "../logger.ts";
import type { EntityModel } from "../model.ts";
import type { Condition } from "../query.ts";
import { jobSettings, parseDuration, type JobDefinition } from "./job.ts";
import { MAX_TIMER_DELAY, systemClock, type JobClock } from "./scheduler.ts";

/** How often each instance deletes the expired run records. */
export const RUN_CLEANUP_INTERVAL = 3_600_000;

/** How many records one cleanup reads per query. */
export const RUN_CLEANUP_BATCH = 500;

export interface JobRunCleanupOptions {
  /** The job registry: each job keeps its records for its own `retention`. */
  jobs: ReadonlyMap<string, JobDefinition>;
  database: DatabaseAdapter;
  /** The `JobRun` model the database was connected with. */
  model: EntityModel;
  /** The resolved `jobs` config; `retention` applies to jobs without their own and to jobs no longer in the registry. */
  config: ResolvedConfig["jobs"];
  /** Cleans nothing when false (`jobs.enabled`). */
  enabled: boolean;
  logger: Logger;
  clock?: JobClock;
}

export interface JobRunCleanup {
  /** Deletes the expired records now and then once per hour; a no-op when disabled. */
  start(): void;
  stop(): void;
  /** Deletes the finished records older than their job's retention and resolves with how many this call deleted. */
  cleanup(): Promise<number>;
  /** Resolves when every cleanup started so far has finished. */
  idle(): Promise<void>;
}

const field = (name: string, op: "eq" | "ne" | "nin" | "lt", value: unknown): Condition => ({ field: name, op, value });

/** Deletes `JobRun` records past their job's retention, on every instance with jobs enabled. */
export function createJobRunCleanup(options: JobRunCleanupOptions): JobRunCleanup {
  const { jobs, database, model, config, logger } = options;
  const clock = options.clock ?? systemClock;
  const pending = new Set<Promise<unknown>>();
  let timer: unknown;
  let started = false;

  const retentionMs = (retention: string): number => parseDuration(retention) ?? parseDuration(config.retention)!;

  /** One condition list per retention: each registered job, then every job no longer in the registry. */
  const scopes = (now: number): Condition[][] => {
    const finished = field("status", "ne", "running");
    const before = (retention: string) => field("startedAt", "lt", new Date(now - retentionMs(retention)));
    return [
      ...[...jobs].map(([name, definition]) => [field("job", "eq", name), finished, before(jobSettings(definition.options, config).retention)]),
      [...(jobs.size > 0 ? [field("job", "nin", [...jobs.keys()])] : []), finished, before(config.retention)],
    ];
  };

  // Every instance may delete the same records at once: a record counts only for the instance whose delete removed it.
  const deleteExpired = async (where: Condition[]): Promise<number> => {
    let deleted = 0;
    for (;;) {
      const { data } = await database.findMany(model, { where, sort: [{ field: "startedAt", direction: "asc" }], limit: RUN_CLEANUP_BATCH, offset: 0, withTotal: false });
      for (const record of data) if (await database.deleteById(model, record.id)) deleted++;
      if (data.length < RUN_CLEANUP_BATCH) return deleted;
    }
  };

  const cleanup = (): Promise<number> => {
    const promise = (async () => {
      let deleted = 0;
      for (const where of scopes(clock.now())) deleted += await deleteExpired(where);
      safeLog(logger, "info", { timestamp: new Date(clock.now()).toISOString(), message: "job-runs.cleanup", deleted });
      return deleted;
    })();
    pending.add(promise);
    const forget = () => pending.delete(promise);
    promise.then(forget, forget);
    return promise;
  };

  const tick = () => {
    cleanup().catch((error: unknown) => {
      safeLog(logger, "error", {
        timestamp: new Date(clock.now()).toISOString(),
        message: "job-runs.cleanup",
        error: error instanceof Error ? error.message : String(error),
      });
    });
    timer = clock.setTimeout(() => {
      if (started) tick();
    }, Math.min(RUN_CLEANUP_INTERVAL, MAX_TIMER_DELAY));
  };

  return {
    start() {
      if (started || !options.enabled) return;
      started = true;
      tick();
    },
    stop() {
      started = false;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
    cleanup,
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
