import { abortReason, startTimer } from "./attempts.ts";
import type { JobRun } from "./job-run.ts";
import { flushLogs, safeLog, type Logger } from "../logger.ts";
import { systemClock, type JobClock, type JobRunner } from "./scheduler.ts";

/** How often each instance looks for runs whose instance stopped sending heartbeats. */
export const ABANDONED_CHECK_INTERVAL = 60_000;

/** How often a running run's `heartbeatAt` is refreshed: a third of its timeout, between 1s and 30s. */
export function heartbeatInterval(timeoutMs: number): number {
  return Math.min(Math.max(Math.floor(timeoutMs / 3), 1000), 30_000);
}

/** Whether a `running` record has gone longer than its timeout without a heartbeat (or, without one, since it started). */
export function isAbandoned(run: Pick<JobRun, "startedAt" | "heartbeatAt">, timeoutMs: number, now: number): boolean {
  const last = run.heartbeatAt ?? run.startedAt;
  return now - new Date(last).getTime() > timeoutMs;
}

/** Calls `callback` every `ms` on `clock` until the returned function is called. */
export function startRepeating(clock: JobClock, ms: number, callback: () => void): () => void {
  let cancel = () => {};
  let stopped = false;
  const next = () => {
    cancel = startTimer(clock, ms, () => {
      if (stopped) return;
      next();
      callback();
    });
  };
  next();
  return () => {
    stopped = true;
    cancel();
  };
}

/** The reason `ctx.signal` is aborted with when the server shuts down. */
export const SHUTDOWN_MESSAGE = "Interrupted by shutdown";
export const shutdownError = (): Error => abortReason(SHUTDOWN_MESSAGE, "AbortError");

/** Something that can receive the termination signals: `process`, or a fake one in tests. */
export type SignalTarget = Pick<NodeJS.Process, "once" | "exit">;

/**
 * Runs `shutdown` once on the first `SIGTERM` or `SIGINT`, writes the buffered log lines, then exits with 0 (1 when the
 * shutdown fails). A second signal while shutting down waits for the same shutdown.
 */
export function handleShutdownSignals(shutdown: () => Promise<void>, target: SignalTarget = process): void {
  let running: Promise<void> | undefined;
  const exit = (code: number) => {
    flushLogs();
    target.exit(code);
  };
  const onSignal = () => {
    running ??= shutdown().then(
      () => exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        exit(1);
      },
    );
  };
  target.once("SIGTERM", onSignal);
  target.once("SIGINT", onSignal);
}

export interface AbandonedRunMonitorOptions {
  /** Checks nothing when false: jobs are disabled or the registry is empty. */
  enabled: boolean;
  logger: Logger;
  clock?: JobClock;
}

export interface AbandonedRunMonitor {
  /** Checks for abandoned runs now and then once a minute. */
  start(): void;
  stop(): void;
}

/** Runs the abandoned-run check of `runner` at startup and once a minute. */
export function createAbandonedRunMonitor(runner: Pick<JobRunner, "markAbandoned">, options: AbandonedRunMonitorOptions): AbandonedRunMonitor {
  const clock = options.clock ?? systemClock;
  let stop: (() => void) | undefined;
  const check = () => {
    runner.markAbandoned().catch((error: unknown) => {
      safeLog(options.logger, "error", {
        timestamp: new Date(clock.now()).toISOString(),
        message: "job.error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  return {
    start() {
      if (stop || !options.enabled) return;
      stop = startRepeating(clock, ABANDONED_CHECK_INTERVAL, check);
      check();
    },
    stop() {
      stop?.();
      stop = undefined;
    },
  };
}
