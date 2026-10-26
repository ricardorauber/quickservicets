import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import type { ErrorReport } from "./error-reports.ts";
import { defineFeature } from "./features.ts";
import type { Repositories } from "./hooks.ts";
import { job, type JobDefinition } from "./jobs/job.ts";
import { jobRunEntity } from "./jobs/job-run.ts";
import { jobRunsObserved, observeJobRuns, type ObservedJobRun } from "./jobs/observers.ts";
import { createJobRunner } from "./jobs/scheduler.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import { startService } from "./service.ts";

const quiet = { info() {}, warn() {}, error() {} };
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** A job runner on a memory database, with the features of `config` set up. */
async function runner(jobs: Record<string, JobDefinition>, config: Record<string, unknown> = {}) {
  const adapter = memoryAdapter();
  const resolved = resolveConfig({ database: adapter, logger: quiet, ...config } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [jobRunEntity()], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await adapter.connect([jobRunEntity()]);
  await lifecycle.start({} as never);
  stops.push(() => lifecycle.stop());
  const created = createJobRunner({ jobs: new Map(Object.entries(jobs)), database: adapter, model: jobRunEntity(), repos: {} as Repositories, files: {} as never, config: { ...resolved.jobs, retryDelay: "1s" }, production: false, logger: quiet });
  const run = async (name: string) => {
    await created.run({ job: name, trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    await created.idle();
  };
  return { run };
}

describe("observing job runs", () => {
  test("an observer gets each final status with willRetry; without observers the runner reports to none", async () => {
    expect(jobRunsObserved()).toBe(false);
    let calls = 0;
    const { run } = await runner({
      flaky: job("@daily", () => {
        calls++;
        if (calls === 1) throw new Error("first try fails");
        return "ok";
      }, { retries: 1, retryDelay: "1s" }),
    });
    const seen: ObservedJobRun[] = [];
    const stop = observeJobRuns((observed) => void seen.push(observed));
    stops.push(stop);
    expect(jobRunsObserved()).toBe(true);
    await run("flaky");
    expect(seen.map((observed) => [observed.status, observed.attempt, observed.willRetry])).toEqual([
      ["failed", 1, true],
      ["success", 2, false],
    ]);
    expect(seen[0]!.error!.message).toBe("first try fails");
  }, 10_000);
});

describe("job reports", () => {
  const received: ErrorReport[] = [];
  const reporter = { report: (report: ErrorReport) => void received.push(report) };
  afterEach(() => {
    received.length = 0;
  });
  const failing = () => job("@daily", () => Promise.reject(new Error("always fails")), { retries: 2, retryDelay: "1s" });

  test("by default only the final failed attempt is reported; with every, each one", async () => {
    const final = await runner({ cleanup: failing() }, { errors: { reporter } });
    await final.run("cleanup");
    expect(received.map((report) => [report.kind, report.job!.name, report.job!.attempt, report.error.message])).toEqual([["job", "cleanup", 3, "always fails"]]);
    received.length = 0;
    for (const stop of stops.splice(0).reverse()) await stop();
    const every = await runner({ cleanup: failing() }, { errors: { reporter, jobs: "every" } });
    await every.run("cleanup");
    expect(received.map((report) => report.job!.attempt)).toEqual([1, 2, 3]);
  }, 20_000);

  test("a timed-out final attempt is reported", async () => {
    const { run } = await runner({ slow: job("@daily", () => new Promise(() => undefined), { timeout: "1s" }) }, { errors: { reporter } });
    await run("slow");
    expect(received.map((report) => [report.kind, report.job!.name])).toEqual([["job", "slow"]]);
    expect(received[0]!.error.message).toContain("1s");
  }, 10_000);
});

describe("startup reports", () => {
  test("a feature whose onStart throws after errors set up sends a startup report and exits 1 once the reporter flushed", async () => {
    const order: string[] = [];
    const reporter = {
      report: (report: ErrorReport) => void order.push(`report ${report.kind} ${report.tags.feature} ${report.tags.phase} ${report.error.message}`),
      flush: async () => {
        await Bun.sleep(20);
        order.push("flushed");
      },
    };
    const broken = defineFeature({ key: "broken", after: ["errors"], setup: (ctx) => ctx.app.onStart(() => Promise.reject(new Error("cannot start"))) });
    const target = { on: () => target, exit: (code: number) => void order.push(`exit ${code}`) };
    await startService({
      projectConfig: { database: memoryAdapter(), logger: quiet, errors: { reporter }, broken: {} } as unknown as ServiceConfig,
      models: [],
      crudRoutes: [],
      endpoints: [],
      hooks: new Map(),
      features: [{ folder: "broken", definition: broken }],
      env: {},
      process: target as never,
    });
    // The report is delivered and flushed before the exit (the native's onStop flushes once more).
    expect(order[0]).toBe("report startup broken onStart cannot start");
    expect(order.indexOf("flushed")).toBeGreaterThan(0);
    expect(order.at(-1)).toBe("exit 1");
  });
});
