import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { flushLogs, jsonLogger, safeLog, type Logger } from "./logger.ts";

/** Overrides `server.workers`: a positive integer or `auto`. */
export const WORKERS_ENV = "QS_WORKERS";
/** The `QS_*` name of `server.workers`, which wins over `QS_WORKERS`. */
export const SERVER_WORKERS_ENV = "QS_SERVER_WORKERS";
/** Set by the primary process on each worker it starts: `0` to `workers - 1`. */
export const WORKER_INDEX_ENV = "QS_WORKER_INDEX";

const CGROUP_CPU_MAX = "/sys/fs/cgroup/cpu.max";

function readCgroupCpuMax(): string | undefined {
  try {
    return readFileSync(CGROUP_CPU_MAX, "utf8");
  } catch {
    return undefined;
  }
}

function hostCpus(): number {
  try {
    return availableParallelism();
  } catch {
    return navigator.hardwareConcurrency || 1;
  }
}

/**
 * The CPUs available to this process: the CPU quota of its cgroup (v2 `cpu.max`, as in Linux containers) rounded up,
 * otherwise the CPUs the operating system reports.
 */
export function availableCpus(readCpuMax: () => string | undefined = readCgroupCpuMax, host: () => number = hostCpus): number {
  const cpus = Math.max(1, host());
  const [quota, period] = (readCpuMax() ?? "").trim().split(/\s+/);
  const limit = Number(quota) / Number(period);
  if (quota === "max" || !Number.isFinite(limit) || limit <= 0) return cpus;
  return Math.min(cpus, Math.max(1, Math.ceil(limit)));
}

/** Each worker's share of a connection pool: the total divided by the workers, rounded up, at least 1. */
export function poolSizePerWorker(total: number, workers = 1): number {
  return Math.max(1, Math.ceil(total / Math.max(1, workers)));
}

/** The index of this worker process, or undefined when the process was not started by a primary. */
export function workerIndex(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env[WORKER_INDEX_ENV];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** Whether this process runs the scheduled jobs, the run cleanup and the abandoned-run check: worker 0, or the only process. */
export function runsScheduledWork(env: Record<string, string | undefined> = process.env): boolean {
  return (workerIndex(env) ?? 0) === 0;
}

/** Whether this process should start the workers instead of serving: more than one worker, and not a worker itself. */
export function isPrimary(config: { server: { workers: number } }, env: Record<string, string | undefined> = process.env): boolean {
  return config.server.workers > 1 && workerIndex(env) === undefined;
}

/** A started worker process. */
export interface WorkerProcess {
  readonly pid: number;
  /** Resolves with the exit code once the process has exited. */
  readonly exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

export interface PrimaryOptions {
  workers: number;
  spawn(index: number): WorkerProcess;
  logger?: Logger;
  /** Receives the termination signals and exits: `process`, or a fake one in tests. */
  target?: Pick<NodeJS.Process, "on" | "exit">;
  /** A worker that exits sooner than this after starting is restarted after this delay, so a crash loop does not spin (default 1000 ms). */
  restartDelayMs?: number;
}

/**
 * Starts the workers and keeps them running: a worker that exits is started again with the same index. On the first
 * `SIGTERM` or `SIGINT` the signal is forwarded to every worker, and once all have exited the process exits with 0, or 1
 * when a worker failed. Resolves with that exit code.
 */
export function runPrimary({ workers, spawn, logger = jsonLogger, target = process, restartDelayMs = 1000 }: PrimaryOptions): Promise<number> {
  const running = new Map<number, WorkerProcess>();
  let stopping = false;
  let failed = false;
  const restarts = new Set<ReturnType<typeof setTimeout>>();
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => (finish = resolve));
  const log = (level: keyof Logger, message: string, fields: Record<string, unknown>) =>
    safeLog(logger, level, { timestamp: new Date().toISOString(), message, ...fields });

  const settle = () => {
    if (!stopping || running.size > 0) return;
    const code = failed ? 1 : 0;
    finish(code);
    flushLogs();
    target.exit(code);
  };

  const start = (index: number) => {
    const startedAt = Date.now();
    const worker = spawn(index);
    running.set(index, worker);
    log("info", "worker.started", { worker: index, pid: worker.pid });
    void worker.exited.then((code) => {
      running.delete(index);
      if (stopping) {
        if (code !== 0) failed = true;
        settle();
        return;
      }
      log("error", "worker.exited", { worker: index, pid: worker.pid, code });
      const delay = Date.now() - startedAt < restartDelayMs ? restartDelayMs : 0;
      const timer = setTimeout(() => {
        restarts.delete(timer);
        start(index);
      }, delay);
      restarts.add(timer);
    });
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    for (const timer of restarts) clearTimeout(timer);
    for (const worker of running.values()) worker.kill(signal);
    settle();
  };
  target.on("SIGTERM", () => onSignal("SIGTERM"));
  target.on("SIGINT", () => onSignal("SIGINT"));

  for (let index = 0; index < workers; index++) start(index);
  return done;
}

/** Starts `workers` copies of `script` (the generated server) as worker processes and supervises them with `runPrimary`. */
export function runWorkers(config: { server: { workers: number }; logger?: Logger }, script: string): Promise<number> {
  const workers = config.server.workers;
  return runPrimary({
    workers,
    logger: config.logger,
    spawn: (index) =>
      Bun.spawn([process.execPath, script], {
        env: { ...process.env, [WORKERS_ENV]: String(workers), [SERVER_WORKERS_ENV]: String(workers), [WORKER_INDEX_ENV]: String(index) },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        // Its own process group, so a terminal's Ctrl+C reaches the workers once, through the primary.
        detached: true,
      } as Parameters<typeof Bun.spawn>[1]),
  });
}
