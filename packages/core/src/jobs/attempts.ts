import { parseDuration, type JobSettings } from "./job.ts";
import type { JobRun, JobRunStatus } from "./job-run.ts";
import type { JobClock } from "./scheduler.ts";

/** Longest delay a single timer accepts; longer waits are chained. */
const MAX_DELAY = 2_147_483_647;

/** Calls `callback` once `ms` have passed on `clock`, chaining timers past the longest single delay; returns a cancel function. */
export function startTimer(clock: JobClock, ms: number, callback: () => void): () => void {
  const until = clock.now() + ms;
  let handle: unknown;
  let canceled = false;
  const arm = () => {
    const remaining = until - clock.now();
    handle = clock.setTimeout(
      () => {
        if (canceled) return;
        if (clock.now() < until) return arm();
        callback();
      },
      Math.min(Math.max(remaining, 0), MAX_DELAY),
    );
  };
  arm();
  return () => {
    canceled = true;
    clock.clearTimeout(handle);
  };
}

/** The reason `ctx.signal` is aborted with when a run lasts longer than its timeout. */
export function timeoutError(timeout: string): Error {
  // The same reason `AbortSignal.timeout()` aborts with; the bundled types omit the constructor's arguments.
  const WebException = DOMException as unknown as new (message: string, name: string) => Error;
  return new WebException(`Timed out after ${timeout}`, "TimeoutError");
}

/** The statuses whose runs are retried while attempts remain. */
export const RETRIED_STATUSES: readonly JobRunStatus[] = ["failed", "timedOut", "abandoned"];

/**
 * How long to wait before the next attempt of a finished run: `retryDelay × 2^(attempt − 1)`, or undefined when the
 * run is not retried (its status is not retried, or it was the last attempt).
 */
export function retryDelayOf(run: Pick<JobRun, "status" | "attempt">, settings: Pick<JobSettings, "retries" | "retryDelay">): number | undefined {
  if (!RETRIED_STATUSES.includes(run.status) || run.attempt > settings.retries) return undefined;
  return (parseDuration(settings.retryDelay) ?? 0) * 2 ** (run.attempt - 1);
}
