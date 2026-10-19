import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, memoryAdapter, nextRunTime, resolveConfig, sqliteAdapter, type EntityModel, type JobRun } from "@quickservice/core";
import ts from "typescript";
import { build } from "../build/build.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { run } from "../run.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { listJobsCommand } from "./job-commands.ts";

const CLEANUP = 'import { job } from "@quickservice/core";\nexport default job("0 3 * * *", async () => ({ deleted: 3 }), { timeZone: "America/Sao_Paulo" });\n';
const FAILING = 'import { job } from "@quickservice/core";\nexport default job({ every: "10m" }, async () => { throw new Error("boom"); });\n';
const SLOW =
  'import { job } from "@quickservice/core";\nexport default job("@daily", async (ctx) => { await Bun.sleep(300); ctx.log.info("done"); return { deleted: 1 }; });\n';

const sqliteConfig = (path: string) =>
  `import { defineConfig, sqliteAdapter } from "@quickservice/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }), logger: { info() {}, warn() {}, error() {} } });\n`;

/** A SQLite project with jobs, migrated, and a direct connection to its database. */
async function sqliteProject(files: Record<string, string>) {
  const root = createLinkedProject({ "quickservice.config.ts": "", ...files });
  const path = join(root, "data.db");
  writeFileSync(join(root, "quickservice.config.ts"), sqliteConfig(path));
  await addMigration(root, "Initial", new Date(Date.UTC(2026, 9, 15, 12)));
  await migrate(root);
  const models = parseProjectEntities(root);
  const model = models.find((candidate) => candidate.key === "JobRun")!;
  const records = async (job: string) => {
    const adapter = sqliteAdapter({ path });
    await adapter.connect(models);
    try {
      const { data } = await adapter.findMany(model, { where: [{ field: "job", op: "eq", value: job }], sort: [{ field: "startedAt", direction: "asc" }], limit: 100, offset: 0 });
      return data as unknown as JobRun[];
    } finally {
      await adapter.disconnect();
    }
  };
  const insert = async (record: Partial<JobRun>) => {
    const adapter = sqliteAdapter({ path });
    await adapter.connect(models);
    const now = new Date();
    await adapter.insert(model, {
      id: Bun.randomUUIDv7(),
      createdAt: now,
      updatedAt: now,
      trigger: "schedule",
      scheduledAt: now,
      attempt: 1,
      status: "running",
      startedAt: now,
      logs: [],
      ...record,
    } as never);
    await adapter.disconnect();
  };
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
    return { code, out, err };
  };
  return { root, records, insert, cli, model: model as EntityModel };
}

describe("job run", () => {
  test("records a manual run, prints the outcome and exits with its status", async () => {
    const { cli, records } = await sqliteProject({ "jobs/cleanup/expired-sessions.ts": CLEANUP, "jobs/reports/failing.ts": FAILING });
    const before = Date.now();
    const success = await cli("job", "run", "cleanup/expired-sessions");
    expect(success.code).toBe(0);
    expect(success.out[0]).toMatch(/^Job cleanup\/expired-sessions: success in \d+ms$/);
    expect(success.out[1]).toBe('Result: {"deleted":3}');
    expect(success.err).toEqual([]);
    const [record] = await records("cleanup/expired-sessions");
    expect(record).toMatchObject({ trigger: "manual", attempt: 1, status: "success", result: { deleted: 3 } });
    expect(new Date(record!.scheduledAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(record!.scheduledAt).getTime()).toBeLessThanOrEqual(Date.now());

    const failure = await cli("job", "run", "reports/failing");
    expect(failure.code).toBe(1);
    expect(failure.out[0]).toMatch(/^Job reports\/failing: failed in \d+ms$/);
    expect(failure.err).toEqual(["Error: boom"]);
    expect((await records("reports/failing")).map((entry) => [entry.trigger, entry.status])).toEqual([["manual", "failed"]]);

    const unknown = await cli("job", "run", "nope");
    expect(unknown).toEqual({ code: 1, out: [], err: ["Unknown job nope"] });
  });

  test("skips a running job unless --force is given", async () => {
    const { cli, records, insert } = await sqliteProject({ "jobs/cleanup/expired-sessions.ts": CLEANUP });
    await insert({ job: "cleanup/expired-sessions", scheduledAt: new Date(Date.UTC(2026, 9, 19, 3)) });
    const skipped = await cli("job", "run", "cleanup/expired-sessions");
    expect(skipped).toEqual({ code: 1, out: [], err: ["Job cleanup/expired-sessions is already running; use --force to run it anyway"] });
    expect((await records("cleanup/expired-sessions")).map((entry) => [entry.trigger, entry.status])).toEqual([
      ["schedule", "running"],
      ["manual", "skipped"],
    ]);
    const forced = await cli("job", "run", "cleanup/expired-sessions", "--force");
    expect(forced.code).toBe(0);
    expect(forced.out[0]).toMatch(/: success in \d+ms$/);
    expect((await records("cleanup/expired-sessions")).map((entry) => entry.status)).toEqual(["running", "skipped", "success"]);
  });
});

describe("job list and job runs", () => {
  test("job list prints each job's schedule, time zone and next run time", async () => {
    const { root, cli } = await sqliteProject({ "jobs/cleanup/expired-sessions.ts": CLEANUP, "jobs/reports/failing.ts": FAILING });
    const now = new Date(Date.UTC(2026, 9, 19, 12, 34, 56));
    const { lines, code } = await listJobsCommand(root, now);
    expect(code).toBe(0);
    expect(lines).toEqual([
      "JOB                       SCHEDULE   TIME ZONE          NEXT RUN",
      `cleanup/expired-sessions  0 3 * * *  America/Sao_Paulo  ${nextRunTime("0 3 * * *", "America/Sao_Paulo", now)!.toISOString()}`,
      "reports/failing           every 10m  UTC                2026-10-19T12:40:00.000Z",
    ]);
    expect(lines[1]).toEndWith("2026-10-20T06:00:00.000Z");
    const listed = await cli("job", "list");
    expect(listed.code).toBe(0);
    expect(listed.out).toHaveLength(3);
    expect(listed.out[1]).toMatch(/^cleanup\/expired-sessions +0 3 \* \* \* +America\/Sao_Paulo +\d{4}-\d\d-\d\dT06:00:00\.000Z$/);
    const empty = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG });
    expect((await listJobsCommand(empty, now)).lines).toEqual(["No jobs"]);
  });

  test("job runs prints the latest runs, 20 by default", async () => {
    const { cli, insert } = await sqliteProject({ "jobs/cleanup/expired-sessions.ts": CLEANUP });
    expect((await cli("job", "runs", "cleanup/expired-sessions")).out).toEqual(["No runs of cleanup/expired-sessions"]);
    for (let day = 1; day <= 25; day++) {
      const startedAt = new Date(Date.UTC(2026, 9, day, 3));
      await insert({ job: "cleanup/expired-sessions", scheduledAt: startedAt, startedAt, status: "success", durationMs: day, finishedAt: startedAt });
    }
    await insert({ job: "cleanup/expired-sessions", trigger: "manual", scheduledAt: new Date(Date.UTC(2026, 9, 26, 3)), startedAt: new Date(Date.UTC(2026, 9, 26, 3)), attempt: 2 });
    const five = await cli("job", "runs", "cleanup/expired-sessions", "--limit", "5");
    expect(five.code).toBe(0);
    expect(five.out).toEqual([
      "ATTEMPT  TRIGGER   STATUS   STARTED                   DURATION",
      "2        manual    running  2026-10-26T03:00:00.000Z  -",
      "1        schedule  success  2026-10-25T03:00:00.000Z  25ms",
      "1        schedule  success  2026-10-24T03:00:00.000Z  24ms",
      "1        schedule  success  2026-10-23T03:00:00.000Z  23ms",
      "1        schedule  success  2026-10-22T03:00:00.000Z  22ms",
    ]);
    expect((await cli("job", "runs", "cleanup/expired-sessions")).out).toHaveLength(21);
    expect(await cli("job", "runs", "cleanup/expired-sessions", "--limit", "0")).toEqual({ code: 1, out: [], err: ["--limit must be a positive integer"] });
    expect(await cli("job", "runs", "nope")).toEqual({ code: 1, out: [], err: ["Unknown job nope"] });
  });
});

describe("req.jobs.run", () => {
  const ENDPOINT = `import type { Endpoint } from "@quickservice/core";
const handler: Endpoint = async (repos, req) => req.jobs.run("cleanup/expired-sessions");
export default handler;
`;
  const UNKNOWN = `import type { Endpoint } from "@quickservice/core";
const handler: Endpoint = async (repos, req) => req.jobs.run("nope" as never);
export default handler;
`;
  const HOOK = `import { definePreHook } from "@quickservice/core";
export default definePreHook(async (repos, req) => {
  req.context.hookRun = await req.jobs.run("cleanup/expired-sessions", { force: true });
});
`;
  const HOOKED = `import type { Endpoint } from "@quickservice/core";
/** @startCleanup */
const handler: Endpoint = async (repos, req) => req.context.hookRun;
export default handler;
`;

  async function app() {
    const root = createLinkedProject({
      "quickservice.config.ts": MEMORY_CONFIG,
      "jobs/cleanup/expired-sessions.ts": SLOW,
      "endpoints/cleanup/post.ts": ENDPOINT,
      "endpoints/unknown/post.ts": UNKNOWN,
      "endpoints/hooked/post.ts": HOOKED,
      "hooks/startCleanup.ts": HOOK,
    });
    await build(root);
    const generated = join(root, ".generated");
    const { models } = (await import(join(generated, "models.ts"))) as { models: EntityModel[] };
    const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
    const { jobs } = await import(join(generated, "jobs.ts"));
    const database = memoryAdapter();
    await database.connect(models);
    const config = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {});
    const created = createApp({ models, crudRoutes, endpoints, hooks, config, jobs });
    const model = models.find((candidate) => candidate.key === "JobRun")!;
    const post = (path: string) => created.server.fetch(new Request(`http://x${path}`, { method: "POST" }));
    return { root, ...created, database, model, post };
  }

  test("claims a code run, answers at once and runs the job in the background", async () => {
    const { post, database, model, jobRunner } = await app();
    const startedAt = performance.now();
    const response = await post("/cleanup");
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(response.status).toBe(200);
    const { runId } = (await response.json()) as { runId: string };
    expect(await database.findById(model, runId)).toMatchObject({ trigger: "code", attempt: 1, status: "running" });
    expect(jobRunner.active.has(runId)).toBe(true);
    await jobRunner.idle();
    expect(await database.findById(model, runId)).toMatchObject({ status: "success", result: { deleted: 1 } });

    const second = await post("/cleanup");
    const third = await post("/cleanup");
    const skipped = (await third.json()) as { runId: string };
    expect(await database.findById(model, skipped.runId)).toMatchObject({ trigger: "code", status: "skipped" });
    const forced = (await (await post("/hooked")).json()) as { runId: string };
    expect(await database.findById(model, forced.runId)).toMatchObject({ trigger: "code", status: "running" });
    await jobRunner.idle();
    expect(await database.findById(model, ((await second.json()) as { runId: string }).runId)).toMatchObject({ status: "success" });
    expect(await database.findById(model, forced.runId)).toMatchObject({ status: "success" });

    const unknown = await post("/unknown");
    expect(unknown.status).toBe(500);
  });

  test("an unknown job rejects with its name", async () => {
    const { jobRunner } = await app();
    const { createRequestJobs } = await import("@quickservice/core");
    const jobs = createRequestJobs(jobRunner, { logger: { info() {}, warn() {}, error() {} } });
    await expect(jobs.run("nope" as never)).rejects.toThrow("Unknown job nope");
  });

  test("job names are type-checked against the registry", async () => {
    const { root } = await app();
    const check = join(root, "check.ts");
    writeFileSync(
      check,
      [
        'import "./.generated/jobs.ts";',
        'import { definePreHook, type Endpoint } from "@quickservice/core";',
        "export const ok: Endpoint = async (repos, req) => {",
        '  const { runId } = await req.jobs.run("cleanup/expired-sessions");',
        '  await req.jobs.run("cleanup/expired-sessions", { force: true });',
        "  // @ts-expect-error not a job of the registry",
        '  await req.jobs.run("nope");',
        "  return { runId };",
        "};",
        "export const hook = definePreHook(async (repos, req) => {",
        '  await req.jobs.run("cleanup/expired-sessions");',
        "  // @ts-expect-error not a job of the registry",
        '  await req.jobs.run("cleanup/other");',
        "});",
        "",
      ].join("\n"),
    );
    const program = ts.createProgram([check], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["lib.esnext.d.ts"],
      types: ["bun"],
      typeRoots: [join(import.meta.dir, "../../../../node_modules/@types")],
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(check));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
  });
});
