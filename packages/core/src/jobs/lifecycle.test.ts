import { describe, expect, mock, test } from "bun:test";
import type { DatabaseAdapter, StoredRecord } from "../adapter.ts";
import { createApp } from "../app.ts";
import { resolveConfig } from "../config.ts";
import { job, type JobDefinition } from "./job.ts";
import type { JobRun } from "./job-run.ts";
import { ABANDONED_CHECK_INTERVAL, createAbandonedRunMonitor, handleShutdownSignals, heartbeatInterval, isAbandoned } from "./lifecycle.ts";
import { captureLogger, connectedMemory, fakeClock, jobInstance, jobRunModel, jobRunRecords, START, type FakeClock } from "./test-support.ts";

const at = (ms: number) => new Date(START + ms);
const request = (name: string, scheduledAt = at(0)) => ({ job: name, trigger: "schedule" as const, scheduledAt, attempt: 1 });

/** A `running` record as an instance that stopped would have left it. */
async function leftRunning(database: DatabaseAdapter, fields: Partial<JobRun> & Pick<JobRun, "job" | "startedAt">): Promise<string> {
  const id = Bun.randomUUIDv7();
  const record: StoredRecord = {
    id,
    createdAt: fields.startedAt,
    updatedAt: fields.startedAt,
    trigger: "schedule",
    scheduledAt: fields.startedAt,
    attempt: 1,
    status: "running",
    logs: [],
    ...fields,
  };
  await database.insert(jobRunModel, record);
  return id;
}

/** A runner plus the abandoned-run monitor, as each server instance runs them. */
function monitored(jobs: Record<string, JobDefinition>, database: DatabaseAdapter, clock: FakeClock) {
  const instance = jobInstance(jobs, database, { clock });
  const monitor = createAbandonedRunMonitor(instance.runner, { enabled: true, logger: instance.logger, clock });
  return { ...instance, monitor };
}

describe("heartbeats", () => {
  test("the interval is a third of the timeout, between 1s and 30s", () => {
    expect(heartbeatInterval(30_000)).toBe(10_000);
    expect(heartbeatInterval(9_000)).toBe(3_000);
    expect(heartbeatInterval(1_000)).toBe(1_000);
    expect(heartbeatInterval(2_000)).toBe(1_000);
    expect(heartbeatInterval(90_000)).toBe(30_000);
    expect(heartbeatInterval(5 * 60_000)).toBe(30_000);
  });

  test("a running run refreshes its heartbeat while it runs, and stops once it ends", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const seen: (number | undefined)[] = [];
    const { runner } = jobInstance(
      {
        ten: job({ every: "1h" }, () => clock.sleep(10_000), { timeout: "30s" }),
        long: job({ every: "1h" }, () => clock.sleep(25_000), { timeout: "30s" }),
      },
      database,
      { clock },
    );
    const ten = runner.run(request("ten"));
    await clock.advance(10_000);
    expect((await ten)!.status).toBe("success");
    expect((await jobRunRecords(database))[0]!.heartbeatAt).toEqual(at(10_000));

    const long = runner.run(request("long", at(1)));
    const heartbeat = async () => (await jobRunRecords(database)).find((run) => run.job === "long")!.heartbeatAt?.getTime();
    for (let i = 0; i < 3; i++) {
      await clock.advance(9_999);
      seen.push(await heartbeat());
      await clock.advance(1);
      seen.push(await heartbeat());
    }
    await long;
    expect(seen.map((time) => (time === undefined ? undefined : time - START))).toEqual([undefined, 20_000, 20_000, 30_000, 30_000, 30_000]);
    expect(clock.timers()).toBe(0);
  });
});

describe("abandoned runs", () => {
  test("a record without a recent heartbeat is marked abandoned within a minute and retried", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let calls = 0;
    const options = { timeout: "30s", retries: 1, retryDelay: "1s" };
    const jobs = {
      report: job({ every: "1h" }, (ctx) => (++calls, ctx.run.attempt), options),
      other: job({ every: "1h" }, () => "other", options),
    };
    const stale = await leftRunning(database, { job: "report", startedAt: at(-10_000) });
    const beating = await leftRunning(database, { job: "other", startedAt: at(-120_000), heartbeatAt: at(-5_000), scheduledAt: at(-120_000) });
    const { monitor } = monitored(jobs, database, clock);
    monitor.start();
    await clock.flush();
    expect((await database.findById(jobRunModel, stale))!.status).toBe("running");
    await clock.advance(ABANDONED_CHECK_INTERVAL);
    const marked = (await database.findById(jobRunModel, stale)) as unknown as JobRun;
    expect(marked).toMatchObject({ status: "abandoned", finishedAt: at(ABANDONED_CHECK_INTERVAL), error: { message: "No heartbeat for 30s" } });
    expect((await database.findById(jobRunModel, beating))!.status).toBe("abandoned");
    await clock.advance(1000);
    const runs = (await jobRunRecords(database)).filter((run) => run.job === "report");
    expect(runs.map((run) => [run.attempt, run.status, run.result ?? null])).toEqual([
      [1, "abandoned", null],
      [2, "success", 2],
    ]);
    expect(runs[1]!.startedAt).toEqual(at(ABANDONED_CHECK_INTERVAL + 1000));
    monitor.stop();
    expect(clock.timers()).toBe(0);
  });

  test("a heartbeat keeps a long run alive, and the check runs at startup", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const jobs = { report: job({ every: "1h" }, () => 1, { timeout: "30s" }) };
    const alive = await leftRunning(database, { job: "report", startedAt: at(-600_000), heartbeatAt: at(-1_000) });
    const old = await leftRunning(database, { job: "report", startedAt: at(-31_000), scheduledAt: at(-31_000) });
    const removed = await leftRunning(database, { job: "gone", startedAt: at(-6 * 60_000) });
    const { monitor, runner } = monitored(jobs, database, clock);
    monitor.start();
    await runner.idle();
    expect((await database.findById(jobRunModel, alive))!.status).toBe("running");
    expect((await database.findById(jobRunModel, old))!.status).toBe("abandoned");
    expect((await database.findById(jobRunModel, removed))!).toMatchObject({ status: "abandoned", error: { message: "No heartbeat for 5m" } });
    monitor.stop();
    expect(isAbandoned({ startedAt: at(0), heartbeatAt: null }, 1000, START + 1000)).toBe(false);
    expect(isAbandoned({ startedAt: at(0), heartbeatAt: null }, 1000, START + 1001)).toBe(true);
  });

  test("an abandoned record no longer blocks a skip-overlap job", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    await leftRunning(database, { job: "report", startedAt: at(-60_000) });
    const { runner } = jobInstance({ report: job({ every: "1h" }, () => "ran", { timeout: "30s" }) }, database, { clock });
    expect(await runner.claim(request("report", at(1)))).toMatchObject({ status: "skipped" });
    expect(await runner.markAbandoned()).toHaveLength(1);
    expect(await runner.run(request("report", at(2)))).toMatchObject({ status: "success", result: "ran" });
  });

  test("two instances checking at the same time mark a record once and retry it once", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let calls = 0;
    const jobs = { report: job({ every: "1h" }, () => ++calls, { timeout: "30s", retries: 1, retryDelay: "1s" }) };
    await leftRunning(database, { job: "report", startedAt: at(-60_000) });
    const a = monitored(jobs, database, clock);
    const b = monitored(jobs, database, clock);
    const updates = mock(database.updateById.bind(database));
    database.updateById = updates;
    const [first, second] = await Promise.all([a.runner.markAbandoned(), b.runner.markAbandoned()]);
    expect(first.length + second.length).toBe(1);
    expect(updates).toHaveBeenCalledTimes(2);
    const results = await Promise.all(updates.mock.results.map((result) => result.value));
    expect(results.filter(Boolean)).toHaveLength(1);
    await clock.advance(1000);
    await Promise.all([a.runner.idle(), b.runner.idle()]);
    expect(calls).toBe(1);
    expect((await jobRunRecords(database)).map((run) => [run.attempt, run.status])).toEqual([
      [1, "abandoned"],
      [2, "success"],
    ]);
  });
});

describe("shutdown", () => {
  test("running jobs are aborted, given the grace period, and recorded as interrupted when still running", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let lateResult = false;
    const { runner, entries } = jobInstance(
      {
        stubborn: job({ every: "1h" }, async () => {
          await clock.sleep(60_000);
          lateResult = true;
          return "late";
        }),
        polite: job({ every: "1h" }, (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("stopped")))),
        strict: job({ every: "1h" }, (ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))), {
          retries: 3,
          retryDelay: "1s",
        }),
        flaky: job(
          { every: "1h" },
          () => {
            throw new Error("flaky");
          },
          { retries: 3, retryDelay: "5s" },
        ),
      },
      database,
      { clock },
    );
    const stubborn = runner.run(request("stubborn"));
    const polite = runner.run(request("polite"));
    const strict = runner.run(request("strict"));
    await runner.run(request("flaky"));
    await clock.flush();
    expect(runner.active.size).toBe(3);
    const signals = [...runner.active.values()].map((active) => active.controller.signal);

    let finished = false;
    const shutdown = runner.shutdown(10_000).then(() => (finished = true));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((signals[0]!.reason as Error).name).toBe("AbortError");
    expect(await polite).toMatchObject({ status: "success", result: "stopped" });
    expect(await strict).toMatchObject({ status: "failed", error: { message: "Interrupted by shutdown" } });
    await expect(runner.claim(request("polite", at(1)))).rejects.toThrow("Job runs are not started while the server shuts down");
    await clock.advance(9_999);
    expect(finished).toBe(false);
    await clock.advance(1);
    await shutdown;
    expect(finished).toBe(true);
    expect(await stubborn).toMatchObject({ status: "interrupted", error: { message: "Interrupted by shutdown" }, durationMs: 10_000 });
    expect(entries.find((entry) => entry.message === "job.finished" && entry.job === "stubborn")).toMatchObject({ status: "interrupted" });

    await clock.advance(120_000);
    await runner.idle();
    expect(lateResult).toBe(true);
    const runs = await jobRunRecords(database);
    expect(runs.map((run) => [run.job, run.attempt, run.status]).sort()).toEqual([
      ["flaky", 1, "failed"],
      ["polite", 1, "success"],
      ["strict", 1, "failed"],
      ["stubborn", 1, "interrupted"],
    ]);
  });

  test("without running jobs the shutdown ends at once", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const { runner } = jobInstance({ quick: job({ every: "1h" }, () => 1) }, database, { clock });
    await runner.shutdown(10_000);
    expect(clock.timers()).toBe(0);
  });

  test("the app stops scheduling and waits for the default grace of 10s", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const { logger } = captureLogger();
    let calls = 0;
    const jobs = new Map([["slow", job({ every: "1s" }, () => (++calls, clock.sleep(60_000)))]]);
    const app = createApp({ models: [jobRunModel], crudRoutes: [], endpoints: [], hooks: new Map(), config: resolveConfig({ database, logger }, {}), jobs, clock });
    app.scheduler.start();
    await clock.advance(1000);
    expect(calls).toBe(1);
    const shutdown = app.shutdown();
    await clock.advance(9_999);
    expect((await jobRunRecords(database)).find((run) => run.status === "interrupted")).toBeUndefined();
    await clock.advance(1);
    await shutdown;
    await clock.advance(5000);
    expect(calls).toBe(1);
    expect(clock.timers()).toBe(1);
    const runs = await jobRunRecords(database);
    expect(runs.map((run) => run.status)).toEqual(["interrupted"]);
    expect(runs[0]!.finishedAt).toEqual(at(11_000));
  });

  test("SIGTERM and SIGINT run the shutdown once and then exit", async () => {
    const handlers = new Map<string, () => void>();
    const exit = mock((_code?: number) => undefined as never);
    const target = { once: (event: string, handler: () => void) => handlers.set(event, handler), exit } as never;
    let release = () => {};
    const shutdown = mock(() => new Promise<void>((resolve) => (release = resolve)));
    handleShutdownSignals(shutdown, target);
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    release();
    await Bun.sleep(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
