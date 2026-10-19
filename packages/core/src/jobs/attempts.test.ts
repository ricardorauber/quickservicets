import { describe, expect, test } from "bun:test";
import { retryDelayOf, startTimer } from "./attempts.ts";
import { job, type JobContext } from "./job.ts";
import { JOB_RUN_STATUSES } from "./job-run.ts";
import { systemClock } from "./scheduler.ts";
import { runOnDemand } from "./triggers.ts";
import { connectedMemory, fakeClock, jobInstance, jobRunModel, jobRunRecords, START } from "./test-support.ts";

const at = (ms: number) => new Date(START + ms);
const request = (name: string, trigger: "schedule" | "manual" = "schedule") => ({ job: name, trigger, scheduledAt: new Date(START), attempt: 1 });

describe("timeouts", () => {
  test("a run longer than its timeout is aborted and recorded as timed out, and its late outcome is ignored", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let signal: AbortSignal | undefined;
    let abortedAt: number | undefined;
    const { runner, entries } = jobInstance(
      {
        slow: job(
          { every: "1m" },
          async (ctx) => {
            signal = ctx.signal;
            ctx.signal.addEventListener("abort", () => (abortedAt = clock.now()));
            await clock.sleep(3000);
            ctx.log.info("still here");
            return "late";
          },
          { timeout: "1s" },
        ),
        failsLate: job(
          { every: "1m" },
          async () => {
            await clock.sleep(2000);
            throw new Error("late failure");
          },
          { timeout: "1s" },
        ),
      },
      database,
      { clock },
    );
    const pending = runner.run(request("slow"));
    await clock.advance(999);
    expect(signal?.aborted).toBe(false);
    expect((await jobRunRecords(database))[0]!.status).toBe("running");
    await clock.advance(1);
    const finished = (await pending)!;
    expect(finished).toMatchObject({ status: "timedOut", error: { message: "Timed out after 1s" }, durationMs: 1000 });
    expect(signal?.aborted).toBe(true);
    expect(abortedAt).toBe(START + 1000);
    expect(signal?.reason).toBeInstanceOf(DOMException);
    expect((signal?.reason as DOMException).name).toBe("TimeoutError");
    const [stored] = await jobRunRecords(database);
    expect(stored).toMatchObject({ status: "timedOut", error: { message: "Timed out after 1s" }, durationMs: 1000, finishedAt: at(1000) });
    expect(runner.active.size).toBe(0);
    expect(entries.find((entry) => entry.message === "job.finished")).toMatchObject({ level: "error", status: "timedOut" });

    await clock.advance(5000);
    await runner.idle();
    expect((await jobRunRecords(database))[0]).toEqual(stored!);

    const failsLate = runner.run({ ...request("failsLate"), scheduledAt: at(10_000) });
    await clock.advance(1000);
    expect(await failsLate).toMatchObject({ status: "timedOut" });
    await clock.advance(5000);
    await runner.idle();
    const late = (await jobRunRecords(database)).find((run) => run.job === "failsLate")!;
    expect(late).toMatchObject({ status: "timedOut", error: { message: "Timed out after 1s" } });
  });

  test("the timeout defaults to the jobs config and a run within it keeps its outcome", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const { runner } = jobInstance(
      { quick: job({ every: "1m" }, async () => (await clock.sleep(1500), "done")) },
      database,
      { clock, config: { jobs: { timeout: "2s" } } },
    );
    const pending = runner.run(request("quick"));
    await clock.advance(1500);
    expect(await pending).toMatchObject({ status: "success", result: "done", durationMs: 1500 });
    expect(clock.timers()).toBe(0);

    const slow = jobInstance({ slow: job({ every: "1m" }, (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", resolve))) }, database, {
      clock,
      config: { jobs: { timeout: "2s" } },
    });
    const timedOut = slow.runner.run({ ...request("slow"), scheduledAt: at(5000) });
    await clock.advance(2000);
    expect(await timedOut).toMatchObject({ status: "timedOut", error: { message: "Timed out after 2s" } });
  });

  test("with the system clock, the signal is aborted after the timeout while the closure keeps waiting", async () => {
    const database = await connectedMemory();
    let abortedAfterOneSecond: boolean | undefined;
    const { runner } = jobInstance(
      {
        wait: job(
          { every: "1m" },
          async (ctx: JobContext) => {
            setTimeout(() => (abortedAfterOneSecond = ctx.signal.aborted), 1100);
            await new Promise((resolve) => setTimeout(resolve, 3000));
          },
          { timeout: "1s" },
        ),
      },
      database,
      { clock: systemClock },
    );
    const started = Date.now();
    const run = (await runner.run({ ...request("wait"), scheduledAt: new Date() }))!;
    const elapsed = Date.now() - started;
    expect(run).toMatchObject({ status: "timedOut", error: { message: "Timed out after 1s" } });
    expect(elapsed).toBeGreaterThanOrEqual(990);
    expect(elapsed).toBeLessThan(2500);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(abortedAfterOneSecond).toBe(true);
  });

  test("timers longer than the longest single delay are chained", async () => {
    const clock = fakeClock();
    let fired = 0;
    startTimer(clock, 30 * 86_400_000, () => fired++);
    await clock.advance(25 * 86_400_000);
    expect(fired).toBe(0);
    await clock.advance(5 * 86_400_000);
    expect(fired).toBe(1);
    const cancel = startTimer(clock, 1000, () => fired++);
    cancel();
    await clock.advance(2000);
    expect(fired).toBe(1);
  });
});

describe("retries", () => {
  test("failed attempts are retried with exponential backoff, each as its own record", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const attempts: number[] = [];
    const { runner } = jobInstance(
      {
        flaky: job(
          { every: "1h" },
          (ctx) => {
            attempts.push(ctx.run.attempt);
            if (ctx.run.attempt < 3) throw new Error(`attempt ${ctx.run.attempt} failed`);
            return "ok";
          },
          { retries: 3, retryDelay: "1s" },
        ),
      },
      database,
      { clock },
    );
    expect(await runner.run(request("flaky", "manual"))).toMatchObject({ status: "failed", attempt: 1 });
    await clock.advance(999);
    expect(await jobRunRecords(database)).toHaveLength(1);
    let idle = false;
    const waiting = runner.idle().then(() => (idle = true));
    await clock.advance(1);
    expect(await jobRunRecords(database)).toHaveLength(2);
    await clock.advance(1999);
    expect(await jobRunRecords(database)).toHaveLength(2);
    expect(idle).toBe(false);
    await clock.advance(1);
    await waiting;
    expect(idle).toBe(true);
    const runs = await jobRunRecords(database);
    expect(runs.map((run) => [run.attempt, run.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "success"],
    ]);
    expect(runs.map((run) => run.startedAt.getTime() - START)).toEqual([0, 1000, 3000]);
    expect(runs.every((run) => run.scheduledAt.getTime() === START && run.trigger === "manual" && run.job === "flaky")).toBe(true);
    expect(runs.map((run) => run.error?.message ?? null)).toEqual(["attempt 1 failed", "attempt 2 failed", null]);
    expect(new Set(runs.map((run) => run.id)).size).toBe(3);
    expect(attempts).toEqual([1, 2, 3]);
  });

  test("on-demand runs are retried like scheduled runs", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const { runner } = jobInstance(
      { flaky: job({ every: "1h" }, (ctx) => (ctx.run.attempt < 3 ? Promise.reject(new Error("no")) : "ok"), { retries: 2, retryDelay: "1s" }) },
      database,
      { clock },
    );
    expect(await runOnDemand(runner, { job: "flaky", trigger: "code", at: new Date(START) })).toMatchObject({ status: "failed", attempt: 1 });
    const waiting = runner.idle();
    await clock.advance(3000);
    await waiting;
    const runs = await jobRunRecords(database);
    expect(runs.map((run) => [run.attempt, run.status, run.trigger])).toEqual([
      [1, "failed", "code"],
      [2, "failed", "code"],
      [3, "success", "code"],
    ]);
  });

  test("scheduled runs are retried through the scheduler's runner", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const { scheduler } = jobInstance(
      { flaky: job({ every: "1h" }, (ctx) => (ctx.run.attempt === 1 ? Promise.reject(new Error("no")) : ctx.run.attempt), { retries: 2, retryDelay: "10s" }) },
      database,
      { clock },
    );
    scheduler.start();
    const firstRun = scheduler.nextRuns.get("flaky")!;
    await clock.advance(firstRun.getTime() - START + 10_000);
    await scheduler.idle();
    scheduler.stop();
    const runs = await jobRunRecords(database);
    expect(runs.map((run) => [run.attempt, run.status, run.result ?? null, run.trigger])).toEqual([
      [1, "failed", null, "schedule"],
      [2, "success", 2, "schedule"],
    ]);
    expect(runs.every((run) => run.scheduledAt.getTime() === firstRun.getTime())).toBe(true);
  });
});

describe("retry limits", () => {
  test("a job that always fails stops after its last retry", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let calls = 0;
    const { runner } = jobInstance(
      {
        broken: job(
          { every: "1h" },
          () => {
            calls++;
            throw new Error("broken");
          },
          { retries: 1, retryDelay: "1s" },
        ),
        once: job(
          { every: "1h" },
          () => {
            throw new Error("once");
          },
        ),
      },
      database,
      { clock },
    );
    await runner.run(request("broken"));
    await runner.run(request("once"));
    for (let i = 0; i < 10; i++) {
      await clock.advance(60_000);
      await runner.idle();
    }
    const runs = await jobRunRecords(database);
    expect(runs.filter((run) => run.job === "broken").map((run) => [run.attempt, run.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
    ]);
    expect(runs.filter((run) => run.job === "once").map((run) => run.attempt)).toEqual([1]);
    expect(calls).toBe(2);
    expect(clock.timers()).toBe(0);
  });

  test("a timed-out run is retried and a skipped run is not", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    const { runner } = jobInstance(
      {
        stuck: job({ every: "1h" }, (ctx) => (ctx.run.attempt === 1 ? clock.sleep(10_000) : "recovered"), { timeout: "1s", retries: 1, retryDelay: "1s" }),
        busy: job({ every: "1h" }, () => clock.sleep(5000), { retries: 3, retryDelay: "1s" }),
      },
      database,
      { clock },
    );
    const stuck = runner.execute((await runner.claim(request("stuck")))!);
    const busy = runner.execute((await runner.claim(request("busy")))!);
    const skipped = await runner.run({ ...request("busy"), scheduledAt: at(1) });
    expect(skipped).toMatchObject({ status: "skipped" });
    runner.retry(skipped!);
    await clock.advance(1000);
    expect(await stuck).toMatchObject({ status: "timedOut", attempt: 1 });
    await clock.advance(21_000);
    await Promise.all([busy, runner.idle()]);
    const runs = await jobRunRecords(database);
    expect(runs.filter((run) => run.job === "stuck").map((run) => [run.attempt, run.status, run.startedAt.getTime() - START])).toEqual([
      [1, "timedOut", 0],
      [2, "success", 2000],
    ]);
    expect(runs.filter((run) => run.job === "busy").map((run) => [run.scheduledAt.getTime() - START, run.attempt, run.status])).toEqual([
      [0, 1, "success"],
      [1, 1, "skipped"],
    ]);
  });

  test("only failed, timed-out and abandoned runs are retried while attempts remain", () => {
    const settings = { retries: 2, retryDelay: "30s" };
    const retried = JOB_RUN_STATUSES.filter((status) => retryDelayOf({ status, attempt: 1 }, settings) !== undefined);
    expect(retried).toEqual(["failed", "timedOut", "abandoned"]);
    expect([1, 2, 3].map((attempt) => retryDelayOf({ status: "abandoned", attempt }, settings))).toEqual([30_000, 60_000, undefined]);
    expect(retryDelayOf({ status: "failed", attempt: 1 }, { retries: 0, retryDelay: "30s" })).toBeUndefined();
  });

  test("two instances retrying the same run produce one next attempt", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let calls = 0;
    const jobs = { flaky: job({ every: "1h" }, () => ++calls, { retries: 1, retryDelay: "1s" }) };
    const a = jobInstance(jobs, database, { clock });
    const b = jobInstance(jobs, database, { clock });
    const claimed = (await a.runner.claim(request("flaky")))!;
    await database.updateById(jobRunModel, claimed.id, { status: "failed" });
    const failed = { ...claimed, status: "failed" as const };
    a.runner.retry(failed);
    b.runner.retry(failed);
    await clock.advance(1000);
    await Promise.all([a.runner.idle(), b.runner.idle()]);
    expect(calls).toBe(1);
    expect((await jobRunRecords(database)).map((run) => run.attempt)).toEqual([1, 2]);
  });
});
