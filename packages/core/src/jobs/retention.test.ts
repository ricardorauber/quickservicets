import { describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "../adapter.ts";
import { memoryAdapter } from "../adapters/memory.ts";
import { postgresAdapter } from "../adapters/postgres.ts";
import { createApp } from "../app.ts";
import { resolveConfig } from "../config.ts";
import type { LogEntry, Logger } from "../logger.ts";
import { resetPostgresTables } from "../testing/postgres.ts";
import { job, type JobOptions } from "./job.ts";
import { jobRunEntity, type JobRun } from "./job-run.ts";
import { createJobRunCleanup, RUN_CLEANUP_BATCH, RUN_CLEANUP_INTERVAL } from "./retention.ts";
import type { JobClock } from "./scheduler.ts";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const DAY = 86_400_000;
const model = jobRunEntity();

/** A clock whose timers fire only when the test advances it. */
function fakeClock(start = NOW) {
  let now = start;
  let sequence = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++sequence;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
      await flush();
    },
  } satisfies JobClock & Record<string, unknown>;
}

function captureLogger() {
  const entries: (LogEntry & { level: string })[] = [];
  const logger: Logger = {
    info: (entry) => entries.push({ level: "info", ...entry }),
    warn: (entry) => entries.push({ level: "warn", ...entry }),
    error: (entry) => entries.push({ level: "error", ...entry }),
  };
  const cleanups = () => entries.filter((entry) => entry.message === "job-runs.cleanup");
  return { logger, entries, cleanups };
}

const noop = (options: JobOptions = {}) => job("@daily", () => undefined, options);

let sequence = 0;

/** A run record started `ageDays` ago (plus a few distinct milliseconds, to keep run times unique). */
function record(jobName: string, ageDays: number, status: JobRun["status"] = "success", now = NOW): JobRun {
  const startedAt = new Date(now - ageDays * DAY - ++sequence);
  return {
    id: Bun.randomUUIDv7(),
    createdAt: startedAt,
    updatedAt: startedAt,
    job: jobName,
    trigger: "schedule",
    scheduledAt: startedAt,
    attempt: 1,
    status,
    startedAt,
    ...(status === "running" ? {} : { finishedAt: startedAt, durationMs: 5 }),
    logs: [],
  };
}

async function seed(database: DatabaseAdapter, records: JobRun[]): Promise<Map<string, JobRun>> {
  for (const entry of records) await database.insert(model, entry as never);
  return new Map(records.map((entry) => [entry.id, entry]));
}

async function remaining(database: DatabaseAdapter): Promise<string[]> {
  const { data } = await database.findMany(model, { where: [], sort: [{ field: "startedAt", direction: "asc" }], limit: 10_000, offset: 0 });
  return data.map((entry) => entry.id);
}

async function app(jobs: Record<string, ReturnType<typeof noop>>, enabled = true) {
  const database = memoryAdapter();
  await database.connect([model]);
  const clock = fakeClock();
  const { logger, cleanups } = captureLogger();
  const config = resolveConfig({ database, logger, jobs: { enabled } }, {});
  const created = createApp({ models: [model], crudRoutes: [], endpoints: [], hooks: new Map(), config, jobs: new Map(Object.entries(jobs)), clock });
  return { ...created, database, clock, cleanups };
}

describe("retention", () => {
  test("each job keeps its records for its retention, removed jobs for jobs.retention, at startup and hourly", async () => {
    const { scheduler, database, clock, cleanups } = await app({ "cleanup/expired-sessions": noop(), "reports/weekly": noop({ retention: "7d" }) });
    const old = record("cleanup/expired-sessions", 31);
    const recent = record("cleanup/expired-sessions", 29);
    const oldFailed = record("cleanup/expired-sessions", 45, "failed");
    const weeklyOld = record("reports/weekly", 8, "skipped");
    const weeklyRecent = record("reports/weekly", 6);
    const removedOld = record("legacy/gone", 31, "timedOut");
    const removedRecent = record("legacy/gone", 29);
    await seed(database, [old, recent, oldFailed, weeklyOld, weeklyRecent, removedOld, removedRecent]);

    scheduler.start();
    await scheduler.idle();
    expect((await remaining(database)).sort()).toEqual([recent.id, weeklyRecent.id, removedRecent.id].sort());
    expect(cleanups()).toEqual([expect.objectContaining({ level: "info", deleted: 4 })]);

    await clock.advance(RUN_CLEANUP_INTERVAL - 1);
    expect(cleanups()).toHaveLength(1);
    await clock.advance(1);
    await scheduler.idle();
    expect(cleanups()).toHaveLength(2);
    expect(cleanups()[1]).toMatchObject({ deleted: 0 });

    // Two days later the 6-day-old run is past the 7-day retention; the 29-day-old ones are past 30 days.
    await clock.advance(2 * DAY);
    await scheduler.idle();
    const left = await remaining(database);
    for (const entry of [recent, weeklyRecent, removedRecent]) expect(left).not.toContain(entry.id);
    expect(cleanups().reduce((sum, entry) => sum + Number(entry.deleted), 0)).toBe(7);

    scheduler.stop();
    const stale = record("legacy/gone", 40, "success", clock.now());
    await database.insert(model, stale as never);
    await clock.advance(2 * RUN_CLEANUP_INTERVAL);
    expect(await remaining(database)).toContain(stale.id);
  });

  test("jobs.retention is the default retention", async () => {
    const database = memoryAdapter();
    await database.connect([model]);
    const { logger } = captureLogger();
    const config = resolveConfig({ database, logger, jobs: { retention: "10d" } }, {});
    const cleanup = createJobRunCleanup({ jobs: new Map([["a", noop()]]), database, model, config: config.jobs, enabled: true, logger, clock: fakeClock() });
    const kept = record("a", 9);
    await seed(database, [record("a", 11), kept, record("gone", 11)]);
    expect(await cleanup.cleanup()).toBe(2);
    expect(await remaining(database)).toEqual([kept.id]);
  });

  test("nothing is cleaned with jobs disabled", async () => {
    const { scheduler, database, clock, cleanups } = await app({ a: noop() }, false);
    await seed(database, [record("a", 31)]);
    scheduler.start();
    await clock.advance(2 * RUN_CLEANUP_INTERVAL);
    expect(await remaining(database)).toHaveLength(1);
    expect(cleanups()).toEqual([]);
  });
});

describe("running records", () => {
  test("are kept however old they are", async () => {
    const { runCleanup, database } = await app({ a: noop({ retention: "7d" }) });
    const running = record("a", 40, "running");
    const removedRunning = record("gone", 400, "running");
    await seed(database, [running, removedRunning, record("a", 40, "abandoned"), record("a", 40, "interrupted")]);
    expect(await runCleanup.cleanup()).toBe(2);
    expect((await remaining(database)).sort()).toEqual([running.id, removedRunning.id].sort());
  });
});

describe("concurrent cleanup", () => {
  const expired = (count: number) => Array.from({ length: count }, (_, index) => record(index % 2 ? "a" : "gone", 31 + (index % 5)));

  async function race(databases: [DatabaseAdapter, DatabaseAdapter]) {
    const logs = databases.map(() => captureLogger());
    const clock = fakeClock();
    const config = resolveConfig({ database: databases[0] }, {}).jobs;
    const cleanups = databases.map((database, index) =>
      createJobRunCleanup({ jobs: new Map([["a", noop()]]), database, model, config, enabled: true, logger: logs[index]!.logger, clock }),
    );
    const counts = await Promise.all(cleanups.map((cleanup) => cleanup.cleanup()));
    return { counts, logged: logs.map((log) => log.cleanups().map((entry) => entry.deleted)) };
  }

  test("two instances delete each record once and both log their counts", async () => {
    const database = memoryAdapter();
    await database.connect([model]);
    const kept = record("a", 1);
    await seed(database, [...expired(2 * RUN_CLEANUP_BATCH + 100), kept]);
    const { counts, logged } = await race([database, database]);
    expect(counts[0]! + counts[1]!).toBe(2 * RUN_CLEANUP_BATCH + 100);
    expect(logged).toEqual([[counts[0]], [counts[1]]]);
    expect(await remaining(database)).toEqual([kept.id]);
  });

  const postgresUrl = process.env.TEST_POSTGRES_URL;
  (postgresUrl ? test : test.skip)("two PostgreSQL connections delete each record once", async () => {
    const { SQL } = await import("bun");
    const admin = new SQL(postgresUrl!);
    await resetPostgresTables(admin, [model]);
    await admin.close();
    const first = postgresAdapter({ url: postgresUrl! });
    const second = postgresAdapter({ url: postgresUrl! });
    await first.connect([model]);
    await second.connect([model]);
    try {
      await seed(first, expired(RUN_CLEANUP_BATCH + 50));
      const { counts, logged } = await race([first, second]);
      expect(counts[0]! + counts[1]!).toBe(RUN_CLEANUP_BATCH + 50);
      expect(logged).toEqual([[counts[0]], [counts[1]]]);
      expect(await remaining(first)).toEqual([]);
    } finally {
      await first.disconnect();
      await second.disconnect();
    }
  }, 30000);
});
