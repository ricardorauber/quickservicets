import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseAdapter } from "../adapter.ts";
import { memoryAdapter } from "../adapters/memory.ts";
import { sqliteAdapter } from "../adapters/sqlite.ts";
import { createApp } from "../app.ts";
import { resolveConfig, type ServiceConfig } from "../config.ts";
import type { LogEntry, Logger } from "../logger.ts";
import { createSqliteTables } from "../testing/sql.ts";
import { job, type JobDefinition, type JobFn, type JobOptions, type JobSchedule } from "./job.ts";
import { jobRunEntity, type JobRun } from "./job-run.ts";
import { createJobRunner, createJobScheduler, createLogCollector, storableResult, type JobClock } from "./scheduler.ts";

const START = Date.parse("2026-10-19T10:00:00.250Z");
const model = jobRunEntity();

/** A clock whose timers fire only when the test advances it. */
function fakeClock(start = START) {
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

function captureLogger() {
  const entries: (LogEntry & { level: string })[] = [];
  const logger: Logger = {
    info: (entry) => entries.push({ level: "info", ...entry }),
    warn: (entry) => entries.push({ level: "warn", ...entry }),
    error: (entry) => entries.push({ level: "error", ...entry }),
  };
  return { logger, entries };
}

async function connectedMemory(): Promise<DatabaseAdapter> {
  const database = memoryAdapter();
  await database.connect([model]);
  return database;
}

interface Setup {
  database?: DatabaseAdapter;
  clock?: ReturnType<typeof fakeClock>;
  config?: Partial<ServiceConfig>;
  env?: Record<string, string>;
}

function instance(jobs: Record<string, JobDefinition>, database: DatabaseAdapter, setup: Setup = {}) {
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
  return { clock, runner, scheduler, entries };
}

async function records(database: DatabaseAdapter): Promise<JobRun[]> {
  const { data } = await database.findMany(model, {
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

const iso = (seconds: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, seconds)).toISOString();
const every = (schedule: JobSchedule, fn: JobFn, options?: JobOptions) => job(schedule, fn, options);

describe("scheduling loop", () => {
  test("every tick of an interval produces one successful run with its result", async () => {
    const database = await connectedMemory();
    let calls = 0;
    const { clock, scheduler } = instance({ counter: every({ every: "1s" }, () => ++calls) }, database);
    scheduler.start();
    expect(scheduler.nextRuns.get("counter")?.toISOString()).toBe(iso(1));
    for (let i = 0; i < 3; i++) await clock.advance(1000);
    await scheduler.idle();
    const runs = await records(database);
    expect(runs.map((run) => run.status)).toEqual(["success", "success", "success"]);
    expect(runs.map((run) => run.scheduledAt.toISOString())).toEqual([iso(1), iso(2), iso(3)]);
    expect(runs.map((run) => run.result)).toEqual([1, 2, 3]);
    expect(runs.every((run) => run.trigger === "schedule" && run.attempt === 1)).toBe(true);
    expect(scheduler.nextRuns.get("counter")?.toISOString()).toBe(iso(4));
    scheduler.stop();
    await clock.advance(5000);
    expect(await records(database)).toHaveLength(3);
  });

  test("cron schedules use the job time zone and single dates run once", async () => {
    const database = await connectedMemory();
    const { clock, scheduler } = instance(
      {
        morning: every("0 9 * * *", () => "morning", { timeZone: "America/Sao_Paulo" }),
        once: every({ at: "2026-10-19T10:00:02Z" }, () => "once"),
        past: every({ at: "2026-10-19T09:00:00Z" }, () => "past"),
      },
      database,
    );
    scheduler.start();
    expect(scheduler.nextRuns.get("morning")?.toISOString()).toBe("2026-10-19T12:00:00.000Z");
    expect(scheduler.nextRuns.has("past")).toBe(false);
    await clock.advance(5000);
    await scheduler.idle();
    expect((await records(database)).map((run) => [run.job, run.result])).toEqual([["once", "once"]]);
    expect(scheduler.nextRuns.has("once")).toBe(false);
    await clock.advance(2 * 3_600_000);
    await scheduler.idle();
    expect((await records(database)).map((run) => run.job)).toEqual(["once", "morning"]);
  });

  test("schedules far ahead wait through chained timers", async () => {
    const database = await connectedMemory();
    const { clock, scheduler } = instance({ yearly: every("@yearly", () => "new year") }, database);
    scheduler.start();
    await clock.advance(30 * 86_400_000);
    expect(await records(database)).toHaveLength(0);
    await clock.advance(50 * 86_400_000);
    await scheduler.idle();
    expect((await records(database)).map((run) => run.scheduledAt.toISOString())).toEqual(["2027-01-01T00:00:00.000Z"]);
  });

  test("nothing is scheduled when jobs are disabled", async () => {
    const database = await connectedMemory();
    let calls = 0;
    const { clock, scheduler } = instance({ counter: every({ every: "1s" }, () => ++calls) }, database, { env: { JOBS_ENABLED: "false" } });
    scheduler.start();
    expect(clock.timers()).toBe(0);
    await clock.advance(5000);
    expect(calls).toBe(0);
    expect(await records(database)).toHaveLength(0);
  });
});

describe("claiming", () => {
  test("only one instance holds a job, scheduled time and attempt", async () => {
    const database = await connectedMemory();
    const { runner: first } = instance({ counter: every({ every: "1s" }, () => 1) }, database);
    const { runner: second } = instance({ counter: every({ every: "1s" }, () => 1) }, database);
    const request = { job: "counter", trigger: "schedule" as const, scheduledAt: new Date(iso(1)), attempt: 1 };
    const claimed = await first.claim(request);
    expect(claimed).toMatchObject({ job: "counter", trigger: "schedule", attempt: 1, status: "running", logs: [] });
    expect(await second.claim(request)).toBeNull();
    expect(await second.run(request)).toBeNull();
    expect(await second.claim({ ...request, attempt: 2, force: true })).toMatchObject({ attempt: 2 });
    expect(await records(database)).toHaveLength(2);
  });

  test("two schedulers on one database run each tick once", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let calls = 0;
    const jobs = { counter: every({ every: "1s" }, () => ++calls) };
    const a = instance(jobs, database, { clock });
    const b = instance(jobs, database, { clock });
    a.scheduler.start();
    b.scheduler.start();
    await clock.advance(3000);
    await Promise.all([a.scheduler.idle(), b.scheduler.idle()]);
    expect(calls).toBe(3);
    const runs = await records(database);
    expect(runs.map((run) => run.scheduledAt.toISOString())).toEqual([iso(1), iso(2), iso(3)]);
    expect(runs.every((run) => run.status === "success")).toBe(true);
  });

  describe("two app instances sharing one SQLite database", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    test("run a job once per tick", async () => {
      const dir = mkdtempSync(join(tmpdir(), "quickservicets-jobs-"));
      dirs.push(dir);
      const path = join(dir, "data.db");
      const clock = fakeClock();
      let calls = 0;
      const jobs = new Map([["counter", every({ every: "1s" }, () => ++calls)]]);
      const apps = [];
      for (let i = 0; i < 2; i++) {
        const database = sqliteAdapter({ path });
        await database.connect([model]);
        if (i === 0) await createSqliteTables(database.client!, [model]);
        const { logger } = captureLogger();
        apps.push({ database, app: createApp({ models: [model], crudRoutes: [], endpoints: [], hooks: new Map(), config: resolveConfig({ database, logger }, {}), jobs, clock }) });
      }
      for (const { app } of apps) app.scheduler.start();
      for (let i = 0; i < 3; i++) await clock.advance(1000);
      await Promise.all(apps.map(({ app }) => app.scheduler.idle()));
      for (const { app } of apps) app.scheduler.stop();
      expect(calls).toBe(3);
      const runs = await records(apps[0]!.database);
      expect(runs.map((run) => run.scheduledAt.toISOString())).toEqual([iso(1), iso(2), iso(3)]);
      expect(runs.map((run) => [run.status, run.result])).toEqual([
        ["success", 1],
        ["success", 2],
        ["success", 3],
      ]);
      for (const { database } of apps) await database.disconnect();
    });
  });
});

describe("overlap", () => {
  test("skip records the ticks that fall during a running run", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let calls = 0;
    const { scheduler } = instance({ slow: every({ every: "1s" }, async () => (++calls, await clock.sleep(2500), calls)) }, database, { clock });
    scheduler.start();
    for (let i = 0; i < 4; i++) await clock.advance(1000);
    scheduler.stop();
    await clock.advance(5000);
    await scheduler.idle();
    const runs = await records(database);
    expect(runs.map((run) => [run.scheduledAt.toISOString(), run.status])).toEqual([
      [iso(1), "success"],
      [iso(2), "skipped"],
      [iso(3), "skipped"],
      [iso(4), "success"],
    ]);
    expect(calls).toBe(2);
    for (const skipped of runs.filter((run) => run.status === "skipped")) {
      expect(skipped.startedAt.getTime()).toBe(skipped.scheduledAt.getTime());
      expect(skipped.finishedAt?.getTime()).toBe(skipped.startedAt.getTime());
    }
    expect(runs[0]!.durationMs).toBe(2500);
  });

  test("parallel runs on every tick", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let calls = 0;
    const { scheduler } = instance({ slow: every({ every: "1s" }, async () => (++calls, await clock.sleep(2500), "done"), { overlap: "parallel" }) }, database, { clock });
    scheduler.start();
    for (let i = 0; i < 4; i++) await clock.advance(1000);
    scheduler.stop();
    await clock.advance(5000);
    await scheduler.idle();
    const runs = await records(database);
    expect(runs.map((run) => run.status)).toEqual(["success", "success", "success", "success"]);
    expect(calls).toBe(4);
  });

  test("force runs a job that is already running", async () => {
    const database = await connectedMemory();
    const { runner } = instance({ slow: every({ every: "1s" }, () => 1) }, database);
    const request = { job: "slow", trigger: "schedule" as const, scheduledAt: new Date(iso(1)), attempt: 1 };
    await runner.claim(request);
    expect(await runner.claim({ ...request, scheduledAt: new Date(iso(2)) })).toMatchObject({ status: "skipped" });
    expect(await runner.claim({ ...request, scheduledAt: new Date(iso(3)), force: true })).toMatchObject({ status: "running" });
  });
});

describe("outcomes", () => {
  const request = (job: string) => ({ job, trigger: "schedule" as const, scheduledAt: new Date(iso(1)), attempt: 1 });

  test("success stores the result, the end time and the duration", async () => {
    const database = await connectedMemory();
    const clock = fakeClock();
    let seen: unknown;
    const { runner, entries } = instance(
      {
        report: every({ every: "1s" }, async (ctx) => {
          seen = ctx.run;
          await clock.sleep(1500);
          return { deleted: 3, at: new Date(iso(5)) };
        }),
        quiet: every({ every: "1s" }, () => undefined),
      },
      database,
      { clock },
    );
    const pending = runner.run(request("report"));
    await clock.advance(2000);
    const run = (await pending)!;
    expect(seen).toEqual({ id: run.id, job: "report", scheduledAt: new Date(iso(1)), attempt: 1, trigger: "schedule" });
    const [stored] = await records(database);
    expect(stored).toMatchObject({ status: "success", durationMs: 1500, result: { deleted: 3, at: iso(5) } });
    expect(stored!.finishedAt!.getTime() - stored!.startedAt.getTime()).toBe(1500);
    expect(stored!.error ?? null).toBeNull();
    const events = entries.filter((entry) => String(entry.message).startsWith("job."));
    expect(events).toEqual([
      expect.objectContaining({ level: "info", message: "job.started", job: "report", runId: run.id, status: "running" }),
      expect.objectContaining({ level: "info", message: "job.finished", job: "report", runId: run.id, status: "success", durationMs: 1500 }),
    ]);
    const quiet = await runner.run({ ...request("quiet"), scheduledAt: new Date(iso(2)) });
    expect(quiet?.status).toBe("success");
    expect((await records(database))[1]!.result ?? undefined).toBeUndefined();
  });

  test("failure stores the error with its stack outside production", async () => {
    const database = await connectedMemory();
    const jobs = {
      boom: every({ every: "1s" }, async () => {
        throw new Error("boom");
      }),
      sync: every({ every: "1s" }, () => {
        throw "plain";
      }),
    };
    const { runner, entries } = instance(jobs, database);
    const failed = await runner.run(request("boom"));
    expect(failed).toMatchObject({ status: "failed", error: { message: "boom" } });
    const [stored] = await records(database);
    expect(stored).toMatchObject({ status: "failed", error: { message: "boom" } });
    expect(stored!.error!.stack).toContain("boom");
    expect(typeof stored!.durationMs).toBe("number");
    expect(stored!.finishedAt).toBeInstanceOf(Date);
    expect(entries.find((entry) => entry.message === "job.finished")).toMatchObject({ level: "error", status: "failed", job: "boom" });
    expect(await runner.run({ ...request("sync"), scheduledAt: new Date(iso(2)) })).toMatchObject({ status: "failed", error: { message: "plain" } });
  });

  test("production hides the stack", async () => {
    const database = await connectedMemory();
    const { runner } = instance(
      {
        boom: every({ every: "1s" }, () => {
          throw new Error("boom");
        }),
      },
      database,
      { config: { production: true } },
    );
    await runner.run(request("boom"));
    const [stored] = await records(database);
    expect(stored!.error).toEqual({ message: "boom" });
  });
});

describe("logs and limits", () => {
  const request = (job: string) => ({ job, trigger: "schedule" as const, scheduledAt: new Date(iso(1)), attempt: 1 });

  test("log lines go to the service logger and the record, within the line limit", async () => {
    const database = await connectedMemory();
    const { runner, entries } = instance(
      {
        chatty: every({ every: "1s" }, (ctx) => {
          ctx.log.info("starting", { batch: 7 });
          for (let i = 1; i < 600; i++) ctx.log.info(`line ${i}`);
        }),
        warned: every({ every: "1s" }, (ctx) => {
          ctx.log.warn("careful");
          ctx.log.error("bad");
        }),
      },
      database,
    );
    const run = (await runner.run(request("chatty")))!;
    const [stored] = await records(database);
    expect(stored!.logs).toHaveLength(500);
    expect(stored!.logs[0]).toEqual({ level: "info", message: "starting", at: expect.any(String), fields: { batch: 7 } });
    expect(stored!.logs[498]).toMatchObject({ level: "info", message: "line 498" });
    expect(stored!.logs[499]).toMatchObject({ message: "101 more lines omitted" });
    const warned = (await runner.run({ ...request("warned"), scheduledAt: new Date(iso(2)) }))!;
    expect(warned.logs.map((line) => [line.level, line.message])).toEqual([["warn", "careful"], ["error", "bad"]]);
    const lines = entries.filter((entry) => entry.runId === run.id && !String(entry.message).startsWith("job."));
    expect(lines).toHaveLength(600);
    expect(lines[0]).toMatchObject({ level: "info", message: "starting", batch: 7, job: "chatty", runId: run.id });
  });

  test("a limit set in the config applies", () => {
    const collector = createLogCollector(3, () => START);
    for (let i = 0; i < 3; i++) collector.add({ level: "info", message: `${i}`, at: "" });
    expect(collector.lines().map((line) => line.message)).toEqual(["0", "1", "2"]);
    collector.add({ level: "info", message: "3", at: "" });
    expect(collector.lines().map((line) => line.message)).toEqual(["0", "1", "2 more lines omitted"]);
  });

  test("a result over the size limit is not stored and the log says so", async () => {
    const database = await connectedMemory();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { runner } = instance(
      {
        large: every({ every: "1s" }, () => "x".repeat(100 * 1024)),
        circular: every({ every: "1s" }, () => circular),
        big: every({ every: "1s" }, () => 10n),
      },
      database,
    );
    await runner.run(request("large"));
    await runner.run({ ...request("circular"), scheduledAt: new Date(iso(2)) });
    await runner.run({ ...request("big"), scheduledAt: new Date(iso(3)) });
    const [large, circularRun, big] = await records(database);
    expect(large!.status).toBe("success");
    expect(large!.result ?? undefined).toBeUndefined();
    expect(large!.logs.map((line) => line.message)).toEqual(["Result larger than 64KB was not stored"]);
    expect(circularRun!.result ?? undefined).toBeUndefined();
    expect(circularRun!.logs.map((line) => line.message)).toEqual(["Result is not JSON-serializable"]);
    expect(big!.logs.map((line) => line.message)).toEqual(["Result is not JSON-serializable"]);
  });

  test("result limits", () => {
    expect(storableResult(undefined, "64KB")).toEqual({});
    expect(storableResult({ a: 1 }, 100)).toEqual({ result: { a: 1 } });
    expect(storableResult("x".repeat(200), 100)).toEqual({ note: "Result larger than 100 bytes was not stored" });
    expect(storableResult(() => 1, "64KB")).toEqual({ note: "Result is not JSON-serializable" });
  });
});
