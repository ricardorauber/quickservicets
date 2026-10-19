import { safeLog, type Logger } from "../logger.ts";
import type { JobRun } from "./job-run.ts";
import { systemClock, type JobClock, type JobRunner } from "./scheduler.ts";

/** The job names of the project, one key per job; the generated `.generated/jobs.ts` fills it in. */
export interface JobNames {}

/** A job name of the project's registry. */
export type JobName = Extract<keyof JobNames, string>;

export interface RunJobOptions {
  /** Runs even when the job is already running and its overlap is `skip`. */
  force?: boolean;
}

/** Starts jobs from endpoints and hooks, as `req.jobs`. */
export interface RequestJobs {
  /**
   * Claims a run of the job with `trigger: "code"` and resolves with its id once the record is stored, without waiting
   * for the job; it runs in the background like a scheduled run. Rejects with `Unknown job <name>` for a name not in
   * the registry.
   */
  run(name: JobName, options?: RunJobOptions): Promise<{ runId: string }>;
}

export interface OnDemandRequest {
  job: string;
  trigger: "manual" | "code";
  /** The run time, normally now. */
  at: Date;
  force?: boolean;
  /** Called with the claimed record, before it is executed. */
  onClaimed?: (run: JobRun) => void;
}

/**
 * Claims and executes a run outside the schedule. When another run of the job already holds that run time (two
 * on-demand runs in the same millisecond), the run time moves 1ms later, so every call gets its own run.
 */
export async function runOnDemand(runner: JobRunner, request: OnDemandRequest): Promise<JobRun> {
  runner.settingsOf(request.job);
  for (let offset = 0; ; offset++) {
    const run = await runner.run({
      job: request.job,
      trigger: request.trigger,
      scheduledAt: new Date(request.at.getTime() + offset),
      attempt: 1,
      force: request.force === true,
      ...(request.onClaimed ? { onClaimed: request.onClaimed } : {}),
    });
    if (run) return run;
  }
}

/** `req.jobs` backed by the runner: each call claims a `code` run and executes it in the background. */
export function createRequestJobs(runner: JobRunner, options: { logger: Logger; clock?: JobClock }): RequestJobs {
  const clock = options.clock ?? systemClock;
  return {
    async run(name, runOptions = {}) {
      runner.settingsOf(name);
      const at = new Date(clock.now());
      const claimed = Promise.withResolvers<JobRun>();
      let reported = false;
      const report = (run: JobRun) => {
        reported = true;
        claimed.resolve(run);
      };
      runOnDemand(runner, { job: name, trigger: "code", at, force: runOptions.force, onClaimed: report }).then(
        (run) => {
          if (!reported) report(run);
        },
        (error: unknown) => {
          if (!reported) return claimed.reject(error);
          safeLog(options.logger, "error", {
            timestamp: new Date(clock.now()).toISOString(),
            message: "job.error",
            job: name,
            scheduledAt: at.toISOString(),
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      return { runId: (await claimed.promise).id };
    },
  };
}

/** `req.jobs` of a server without a job registry. */
export const noRequestJobs: RequestJobs = {
  run: async (name) => {
    throw new Error(`Unknown job ${name}`);
  },
};
