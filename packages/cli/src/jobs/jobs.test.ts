import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJobDefinition, job } from "@quickservicets/core";
import ts from "typescript";
import { build } from "../build/build.ts";
import { BuildError } from "../errors.ts";
import { CORE_IMPORT } from "../testing/core-path.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";
import { jobNameOf, listJobFiles, scanJobs } from "./scan-jobs.ts";
import { jobOptionsError, scheduleError } from "./validate-job.ts";

const jobFile = (schedule: string, options = "") =>
  `import { job } from ${CORE_IMPORT};\nexport default job(${schedule}, async () => 1${options ? `, ${options}` : ""});\n`;

const buildError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BuildError);
    return (error as Error).message;
  }
  throw new Error("expected a BuildError");
};

describe("schedule and option validation", () => {
  test.each(["*/5 * * * *", "0 30 9 * * 1-5", "0 0 1,15 * *", "0-30/10 8-18 * 1-12 0-7", "*/5 * * * * *", "@yearly", "@monthly", "@weekly", "@daily", "@hourly"])(
    "cron %s is valid",
    (cron) => {
      expect(scheduleError(cron)).toBeUndefined();
    },
  );

  test.each([
    ["61 * * * *", "minute value 61 is out of range 0-59"],
    ["* * * *", "expected 5 fields, or 6 with seconds first"],
    ["@often", "unknown preset"],
  ])("cron %s is invalid", (cron, reason) => {
    expect(scheduleError(cron)).toContain(`invalid cron expression "${cron}"`);
    expect(scheduleError(cron)).toContain(reason);
  });

  test("intervals take s, m, h and d, at least 1s", () => {
    for (const every of ["1s", "10s", "15m", "2h", "1d"]) expect(scheduleError({ every })).toBeUndefined();
    expect(scheduleError({ every: "500ms" })).toContain('unknown unit "ms"');
    expect(scheduleError({ every: "5w" })).toContain('unknown unit "w"');
    expect(scheduleError({ every: "0s" })).toContain("the minimum is 1s");
    expect(scheduleError({ every: 10 })).toContain("must be a string");
  });

  test("single dates must be ISO 8601 date-times with an offset", () => {
    for (const at of ["2026-12-01T09:00:00Z", "2026-12-01T09:00Z", "2026-12-01T09:00:00.500-03:00"]) {
      expect(scheduleError({ at })).toBeUndefined();
    }
    for (const at of ["tomorrow", "2026-12-01", "2026-02-30T09:00:00Z", "2026-12-01T09:00:00"]) {
      expect(scheduleError({ at })).toContain(`invalid date "${at}"`);
    }
  });

  test("other schedule shapes are rejected", () => {
    for (const schedule of [5, null, [], {}, { every: "1m", at: "2026-12-01T09:00:00Z" }, { cron: "* * * * *" }]) {
      expect(scheduleError(schedule)).toContain("invalid schedule");
    }
  });

  test("options accept every documented key", () => {
    expect(jobOptionsError({})).toBeUndefined();
    expect(
      jobOptionsError({ retries: 3, retryDelay: "30s", timeout: "10m", retention: "30d", timeZone: "America/Sao_Paulo", overlap: "parallel" }),
    ).toBeUndefined();
    expect(jobOptionsError({ retries: 0, overlap: "skip", timeZone: "UTC" })).toBeUndefined();
  });

  test.each([
    [{ retries: -1 }, "invalid option retries"],
    [{ retries: 1.5 }, "invalid option retries"],
    [{ retries: "3" }, "invalid option retries"],
    [{ retryDelay: "soon" }, "invalid option retryDelay"],
    [{ timeout: 30 }, "invalid option timeout"],
    [{ retention: "30 days" }, "invalid option retention"],
    [{ timeZone: "Mars/Base" }, 'invalid option timeZone: unknown time zone "Mars/Base"'],
    [{ timeZone: 3 }, "invalid option timeZone"],
    [{ overlap: "queue" }, "invalid option overlap"],
    [{ retry: 3 }, 'unknown option "retry"'],
  ])("options %j are invalid", (options, reason) => {
    expect(jobOptionsError(options)).toContain(reason);
  });

  test("job() marks its definition", () => {
    const definition = job({ every: "1m" }, () => 1, { retries: 2 });
    expect(isJobDefinition(definition)).toBe(true);
    expect(definition.schedule).toEqual({ every: "1m" });
    expect(definition.options).toEqual({ retries: 2 });
    expect(job("@daily", () => 1).options).toEqual({});
    expect(isJobDefinition(() => 1)).toBe(false);
  });
});

describe("job scanning", () => {
  test("reads .ts files in subfolders, without test files, and names them by path", async () => {
    const root = createProject({
      "jobs/cleanup/expired-sessions.ts": jobFile('"*/5 * * * *"'),
      "jobs/billing/monthly/close-invoices.ts": jobFile('"@monthly"'),
      "jobs/heartbeat.ts": jobFile('{ every: "10s" }', '{ retries: 2 }'),
      "jobs/heartbeat.test.ts": "throw new Error('test files are not jobs');",
      "jobs/cleanup/expired-sessions.spec.ts": "throw new Error('test files are not jobs');",
      "jobs/README.md": "# jobs",
    });
    expect(listJobFiles(root)).toEqual(["jobs/billing/monthly/close-invoices.ts", "jobs/cleanup/expired-sessions.ts", "jobs/heartbeat.ts"]);
    const jobs = await scanJobs(root);
    expect(jobs.map((entry) => entry.name)).toEqual(["billing/monthly/close-invoices", "cleanup/expired-sessions", "heartbeat"]);
    expect(jobs[2]).toEqual({ name: "heartbeat", file: "jobs/heartbeat.ts", schedule: { every: "10s" }, options: { retries: 2 } });
  });

  test("names come from the path without extension", () => {
    expect(jobNameOf("jobs/billing/close-invoices.ts")).toBe("billing/close-invoices");
    expect(jobNameOf("jobs/nightly.ts")).toBe("nightly");
  });

  test("a project without jobs has none", async () => {
    expect(await scanJobs(createProject({}))).toEqual([]);
    expect(await scanJobs(createProject({ "jobs/.gitkeep": "" }))).toEqual([]);
  });

  test.each([
    ["jobs/bad.ts", "export const x = 1;\n", "jobs/bad.ts: must default-export job(...)"],
    ["jobs/fn.ts", "export default async () => 1;\n", "jobs/fn.ts: must default-export job(...)"],
    ["jobs/a/cron.ts", jobFile('"61 * * * *"'), "jobs/a/cron.ts: invalid cron expression \"61 * * * *\": minute value 61 is out of range 0-59"],
    ["jobs/ms.ts", jobFile('{ every: "500ms" }'), 'jobs/ms.ts: invalid interval "500ms": unknown unit "ms"'],
    ["jobs/week.ts", jobFile('{ every: "5w" }'), 'jobs/week.ts: invalid interval "5w": unknown unit "w"'],
    ["jobs/at.ts", jobFile('{ at: "tomorrow" }'), 'jobs/at.ts: invalid date "tomorrow"'],
    ["jobs/zone.ts", jobFile('"@daily"', '{ timeZone: "Mars/Base" }'), 'jobs/zone.ts: invalid option timeZone: unknown time zone "Mars/Base"'],
    ["jobs/retries.ts", jobFile('"@daily"', "{ retries: -1 }"), "jobs/retries.ts: invalid option retries"],
    ["jobs/timeout.ts", jobFile('"@daily"', '{ timeout: "soon" }'), "jobs/timeout.ts: invalid option timeout"],
  ])("%s fails naming the file and reason", async (file, source, message) => {
    expect(await buildError(scanJobs(createProject({ [file]: source })))).toContain(message);
  });
});

const sessionEntity = "export type Session = { token: string; expiresAt: Date }";
const userEntity = "export type User = { email: string }";

describe("job registry", () => {
  test("lists every job with its name", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": MEMORY_CONFIG,
      "entities/Session.ts": sessionEntity,
      "jobs/cleanup/expired-sessions.ts":
        'import { job } from "@quickservicets/core";\nexport default job("*/5 * * * *", async ({ repos }) => repos.sessions.where((s) => s.expiresAt.lt(new Date())).count());\n',
      "jobs/reports/daily.ts": jobFile('"@daily"'),
    });
    await build(root);
    const registry = readFileSync(join(root, ".generated/jobs.ts"), "utf8");
    expect(registry).toContain('import job0 from "../jobs/cleanup/expired-sessions.ts";');
    expect(registry).toContain('["cleanup/expired-sessions", job0],');
    expect(registry).toContain('["reports/daily", job1],');
    const { jobs } = (await import(join(root, ".generated/jobs.ts"))) as { jobs: Map<string, unknown> };
    expect([...jobs.keys()]).toEqual(["cleanup/expired-sessions", "reports/daily"]);
    expect([...jobs.values()].every(isJobDefinition)).toBe(true);
  });

  test("every schedule form builds", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": MEMORY_CONFIG,
      "jobs/interval.ts": jobFile('{ every: "10s" }'),
      "jobs/preset.ts": jobFile('"@daily"'),
      "jobs/seconds.ts": jobFile('"0 30 9 * * 1-5"'),
      "jobs/once.ts": jobFile('{ at: "2026-12-01T09:00:00Z" }'),
    });
    await build(root);
    const { jobs } = (await import(join(root, ".generated/jobs.ts"))) as { jobs: Map<string, unknown> };
    expect([...jobs.keys()].sort()).toEqual(["interval", "once", "preset", "seconds"]);
  });

  test("is empty without a jobs folder", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, "entities/User.ts": userEntity });
    await build(root);
    const registry = readFileSync(join(root, ".generated/jobs.ts"), "utf8");
    expect(registry).toContain("export const jobs = new Map<string, JobDefinition>([\n]);");
    const { jobs } = (await import(join(root, ".generated/jobs.ts"))) as { jobs: Map<string, unknown> };
    expect(jobs.size).toBe(0);
  });

  test("a failing job file fails the build", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, "jobs/broken.ts": "export {};\n" });
    expect(await buildError(build(root))).toBe("jobs/broken.ts: must default-export job(...)");
  });
});

describe("job context types", () => {
  test("ctx exposes repos, files, signal, log and run", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": MEMORY_CONFIG,
      "entities/User.ts": userEntity,
      "jobs/check.ts": jobFile('"@daily"'),
    });
    await build(root);
    const check = join(root, "jobs/check.ts");
    writeFileSync(
      check,
      [
        'import { job } from "@quickservicets/core";',
        "export default job({ every: \"1m\" }, async (ctx) => {",
        "  const users = await ctx.repos.users.where((u) => u.email.eq(\"a@b.c\")).toArray();",
        "  const storage = ctx.files.default;",
        "  const aborted: boolean = ctx.signal.aborted;",
        '  ctx.log.info("x");',
        '  ctx.log.warn("y", { count: users.length });',
        '  ctx.log.error("z");',
        "  const attempt: number = ctx.run.attempt;",
        '  const trigger: "schedule" | "manual" | "code" = ctx.run.trigger;',
        "  const scheduledAt: Date = ctx.run.scheduledAt;",
        "  // @ts-expect-error there is no such repository",
        "  void ctx.repos.nope;",
        "  return { storage: typeof storage, aborted, attempt, trigger, scheduledAt, id: ctx.run.id, job: ctx.run.job };",
        '}, { retries: 3, retryDelay: "30s", timeout: "5m", retention: "30d", timeZone: "UTC", overlap: "skip" });',
        "",
      ].join("\n"),
    );
    const program = ts.createProgram([check, join(root, ".generated/types.ts")], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
      types: [],
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(check));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
  });
});
