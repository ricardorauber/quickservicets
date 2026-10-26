import type { JobRunStatus } from "./job-run.ts";

/** A job run that reached a final status, as `observeJobRuns` observers receive it. */
export interface ObservedJobRun {
  job: string;
  runId: string;
  attempt: number;
  status: Exclude<JobRunStatus, "running">;
  error?: { message: string; stack?: string };
  /** Whether another attempt of the run follows. */
  willRetry: boolean;
}

const observers: ((run: ObservedJobRun) => void)[] = [];

/**
 * Calls `fn` after each job run record reaches a final status (success, failed, timedOut, skipped, abandoned or
 * interrupted), with whether a retry follows; returns a function that stops it. An observer that throws is ignored.
 */
export function observeJobRuns(fn: (run: ObservedJobRun) => void): () => void {
  observers.push(fn);
  return () => {
    const at = observers.indexOf(fn);
    if (at >= 0) observers.splice(at, 1);
  };
}

/** Whether any observer listens, so the runner does no extra work without one. */
export const jobRunsObserved = () => observers.length > 0;

/** Tells every observer about a finished run. */
export function notifyJobRun(run: ObservedJobRun): void {
  for (const fn of [...observers]) {
    try {
      fn(run);
    } catch {
      // An observer never changes the run.
    }
  }
}
