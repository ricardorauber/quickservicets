import { expect, test } from "bun:test";
import { postgresAdapter } from "./adapters/postgres.ts";
import type { Logger } from "./logger.ts";
import { isPrimary, poolSizePerWorker, runPrimary, type WorkerProcess } from "./workers.ts";

test("the pool is divided across the workers, rounded up and at least one each", async () => {
  expect(poolSizePerWorker(10)).toBe(10);
  expect(poolSizePerWorker(10, 2)).toBe(5);
  expect(poolSizePerWorker(10, 3)).toBe(4);
  expect(poolSizePerWorker(2, 4)).toBe(1);
  const url = process.env.TEST_POSTGRES_URL;
  if (!url) return;
  const pooled = async (options: { max?: number }, workers?: number) => {
    const adapter = postgresAdapter({ url, ...options });
    await adapter.connect([], workers === undefined ? {} : { workers });
    const max = (adapter.client as unknown as { options: { max: number } }).options.max;
    await adapter.disconnect();
    return max;
  };
  expect(await pooled({})).toBe(10);
  expect(await pooled({}, 2)).toBe(5);
  expect(await pooled({ max: 20 }, 3)).toBe(7);
});

class FakeWorker implements WorkerProcess {
  readonly signals: string[] = [];
  readonly exited: Promise<number | null>;
  exit!: (code: number | null) => void;
  constructor(readonly pid: number, readonly index: number) {
    this.exited = new Promise((resolve) => (this.exit = resolve));
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
  }
}

function primary(workers: number) {
  const spawned: FakeWorker[] = [];
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const entries: Record<string, unknown>[] = [];
  const logger: Logger = { info: (entry) => entries.push(entry), warn: (entry) => entries.push(entry), error: (entry) => entries.push(entry) };
  const target = {
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    exit: (code: number) => exits.push(code),
  } as never;
  const done = runPrimary({
    workers,
    logger,
    target,
    restartDelayMs: 20,
    spawn: (index) => {
      const worker = new FakeWorker(1000 + spawned.length, index);
      spawned.push(worker);
      return worker;
    },
  });
  return { spawned, handlers, exits, entries, done };
}

test("the primary starts the workers, restarts one that exits, forwards the first signal and exits once all stopped", async () => {
  expect(isPrimary({ server: { workers: 2 } }, {})).toBe(true);
  expect(isPrimary({ server: { workers: 2 } }, { QS_WORKER_INDEX: "0" })).toBe(false);
  expect(isPrimary({ server: { workers: 1 } }, {})).toBe(false);

  const { spawned, handlers, exits, entries, done } = primary(2);
  expect(spawned.map((worker) => worker.index)).toEqual([0, 1]);

  spawned[1]!.exit(null);
  await Bun.sleep(60);
  expect(spawned.map((worker) => worker.index)).toEqual([0, 1, 1]);
  expect(entries.some((entry) => entry.message === "worker.exited" && entry.worker === 1 && entry.pid === 1001)).toBe(true);

  handlers.get("SIGTERM")!();
  handlers.get("SIGINT")!();
  expect(spawned[0]!.signals).toEqual(["SIGTERM"]);
  expect(spawned[2]!.signals).toEqual(["SIGTERM"]);
  expect(spawned[1]!.signals).toEqual([]);
  spawned[0]!.exit(0);
  await Bun.sleep(10);
  expect(exits).toEqual([]);
  spawned[2]!.exit(0);
  expect(await done).toBe(0);
  expect(exits).toEqual([0]);
  expect(spawned).toHaveLength(3);

  // A worker failing while stopping makes the exit code 1, and a restart still waiting is cancelled.
  const failing = primary(2);
  failing.spawned[0]!.exit(1);
  await Bun.sleep(1);
  failing.handlers.get("SIGINT")!();
  expect(failing.spawned[1]!.signals).toEqual(["SIGINT"]);
  failing.spawned[1]!.exit(1);
  expect(await failing.done).toBe(1);
  await Bun.sleep(40);
  expect(failing.spawned).toHaveLength(2);
  expect(failing.exits).toEqual([1]);
});
