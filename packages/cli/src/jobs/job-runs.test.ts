import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createApp,
  createRepositories,
  jobRunEntity,
  memoryAdapter,
  mongoIndexSpecs,
  postgresAdapter,
  resolveConfig,
  sqliteAdapter,
  UniqueViolationError,
  type DatabaseAdapter,
  type EntityModel,
} from "@quickservice/core";
import { MongoClient } from "mongodb";
import ts from "typescript";
import { build } from "../build/build.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { EntityParseError } from "../entities/errors.ts";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";

const JOB = 'import { job } from "@quickservice/core";\nexport default job("@daily", async () => 1);\n';
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const silent = { info() {}, warn() {}, error() {} };

const run = (overrides: Record<string, unknown> = {}) => ({
  id: Bun.randomUUIDv7(),
  createdAt: new Date(),
  updatedAt: new Date(),
  job: "cleanup/expired-sessions",
  trigger: "schedule",
  scheduledAt: new Date("2026-10-19T10:00:00Z"),
  attempt: 1,
  status: "running",
  startedAt: new Date("2026-10-19T10:00:00Z"),
  logs: [],
  ...overrides,
});

/** Inserting the same job, scheduledAt and attempt twice fails; another attempt does not. */
async function expectUniqueRunIndex(adapter: DatabaseAdapter, model: EntityModel) {
  await adapter.insert(model, run());
  await expect(adapter.insert(model, run())).rejects.toBeInstanceOf(UniqueViolationError);
  await adapter.insert(model, run({ attempt: 2, result: { deleted: 3 }, error: { message: "boom" }, logs: [{ level: "info", message: "x", at: "2026-10-19T10:00:01Z" }] }));
  const { data } = await adapter.findMany(model, { where: [], sort: [{ field: "attempt", direction: "asc" }], limit: 10, offset: 0 });
  expect(data.map((record) => record.attempt)).toEqual([1, 2]);
  expect(data[1]!.result).toEqual({ deleted: 3 });
  expect(data[1]!.logs).toEqual([{ level: "info", message: "x", at: "2026-10-19T10:00:01Z" }]);
}

describe("JobRun model", () => {
  const model = jobRunEntity();

  test("names, fields and flags", () => {
    expect(model).toMatchObject({ key: "JobRun", entityName: "JobRun", name: "job-runs", repoKey: "jobRuns", tableName: "job_runs", schema: null, internal: true, system: true });
    const fields = Object.fromEntries(model.fields.map((field) => [field.name, field]));
    expect(Object.keys(fields)).toEqual(["job", "trigger", "scheduledAt", "attempt", "status", "startedAt", "finishedAt", "durationMs", "heartbeatAt", "result", "error", "logs"]);
    expect(fields.trigger).toMatchObject({ type: "enum", values: ["schedule", "manual", "code"], optional: false });
    expect(fields.status).toMatchObject({ type: "enum", values: ["running", "success", "failed", "timedOut", "skipped", "abandoned", "interrupted"] });
    expect(fields.attempt).toMatchObject({ type: "number", min: 1, optional: false });
    for (const name of ["scheduledAt", "startedAt"]) expect(fields[name]).toMatchObject({ type: "date", optional: false });
    for (const name of ["finishedAt", "heartbeatAt"]) expect(fields[name]).toMatchObject({ type: "date", optional: true });
    expect(fields.durationMs).toMatchObject({ type: "number", optional: true });
    expect(fields.result).toMatchObject({ type: "json", optional: true, storage: "json" });
    expect(fields.error).toMatchObject({ type: "object", optional: true, storage: "json" });
    expect(fields.logs).toMatchObject({ type: "array", optional: false, storage: "json" });
  });

  test("a unique index on job, scheduledAt and attempt and an index on job and startedAt", () => {
    expect(model.indexes).toEqual([{ fields: ["job", "scheduledAt", "attempt"], unique: true }, { fields: ["job", "startedAt"] }]);
    expect(mongoIndexSpecs(model).slice(1)).toEqual([
      { schema: null, collection: "job_runs", name: "job_runs_job_scheduledAt_attempt_uq", keys: { job: 1, scheduledAt: 1, attempt: 1 }, options: { unique: true } },
      { schema: null, collection: "job_runs", name: "job_runs_job_startedAt_idx", keys: { job: 1, startedAt: 1 }, options: {} },
    ]);
  });

  test("the memory adapter enforces the unique index", async () => {
    const adapter = memoryAdapter();
    await adapter.connect([model]);
    await expectUniqueRunIndex(adapter, model);
  });
});

const sqlConfig = (adapter: "sqlite" | "postgres", target: string) =>
  `import { defineConfig, ${adapter}Adapter } from "@quickservice/core";\nexport default defineConfig({ database: ${adapter}Adapter(${adapter === "sqlite" ? `{ path: ${JSON.stringify(target)} }` : `{ url: ${JSON.stringify(target)} }`}) });\n`;

describe("model inclusion", () => {
  test("only projects with jobs get JobRun", () => {
    expect(parseProjectEntities(createProject({ "jobs/nightly.ts": JOB })).map((model) => model.key)).toContain("JobRun");
    expect(parseProjectEntities(createProject({ "jobs/nightly.test.ts": "" })).map((model) => model.key)).not.toContain("JobRun");
    expect(parseProjectEntities(createProject({ "entities/User.ts": "export type User = { email: string }" })).map((model) => model.key)).not.toContain("JobRun");
  });

  test("a project entity taking its name fails", () => {
    expect(() => parseProjectEntities(createProject({ "jobs/nightly.ts": JOB, "entities/JobRun.ts": "export type JobRun = { job: string }" }))).toThrow(EntityParseError);
    expect(() => parseProjectEntities(createProject({ "jobs/nightly.ts": JOB, "entities/JobRun.ts": "export type JobRun = { job: string }" }))).toThrow(
      "entities/JobRun.ts: entity JobRun conflicts with the built-in JobRun entity",
    );
  });

  test.each(["sqlite", "postgres"] as const)("migration add creates the %s table only with jobs", async (adapter) => {
    const config = sqlConfig(adapter, adapter === "sqlite" ? ":memory:" : "postgres://localhost/none");
    const withJobs = createLinkedProject({ "quickservice.config.ts": config, "jobs/nightly.ts": JOB });
    const source = readFileSync(join(withJobs, (await addMigration(withJobs, "Initial", at(0))).file), "utf8");
    expect(source).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?job_runs/);
    expect(source).toMatch(/CREATE UNIQUE INDEX \\?[`"](\{\{default_schema\}\})?job_runs_job_scheduled_at_attempt_uq\\?[`"] ON .*\(\\?[`"]job\\?[`"],\\?[`"]scheduled_at\\?[`"],\\?[`"]attempt\\?[`"]\)/);
    expect(source).toMatch(/CREATE INDEX \\?[`"](\{\{default_schema\}\})?job_runs_job_started_at_idx/);
    const without = createLinkedProject({ "quickservice.config.ts": config, "entities/User.ts": "export type User = { email: string }" });
    expect(readFileSync(join(without, (await addMigration(without, "Initial", at(0))).file), "utf8")).not.toContain("job_runs");
  });

  test("the SQLite table enforces the unique index", async () => {
    const root = createLinkedProject({ "jobs/nightly.ts": JOB, "quickservice.config.ts": "" });
    writeFileSync(join(root, "quickservice.config.ts"), sqlConfig("sqlite", join(root, "data.db")));
    await addMigration(root, "Initial", at(0));
    expect((await migrate(root)).applied).toEqual(["20261015120000_Initial"]);
    const models = parseProjectEntities(root);
    const adapter = sqliteAdapter({ path: join(root, "data.db") });
    await adapter.connect(models);
    await expectUniqueRunIndex(adapter, models.find((model) => model.key === "JobRun")!);
    await adapter.disconnect();
  });

  const postgresUrl = process.env.TEST_POSTGRES_URL;
  (postgresUrl ? test : test.skip)("the PostgreSQL table enforces the unique index", async () => {
    const { SQL } = await import("bun");
    const admin = new SQL(postgresUrl!);
    await admin.unsafe("drop schema if exists public cascade; create schema public;");
    await admin.close();
    const root = createLinkedProject({ "quickservice.config.ts": sqlConfig("postgres", postgresUrl!), "jobs/nightly.ts": JOB });
    await addMigration(root, "Initial", at(0));
    expect((await migrate(root)).applied).toEqual(["20261015120000_Initial"]);
    const models = parseProjectEntities(root);
    const adapter = postgresAdapter({ url: postgresUrl! });
    await adapter.connect(models);
    await expectUniqueRunIndex(adapter, models.find((model) => model.key === "JobRun")!);
    await adapter.disconnect();
    expect((await migrate(root, { target: "0" })).reverted).toEqual(["20261015120000_Initial"]);
  });

  const mongoUrl = process.env.TEST_MONGODB_URL;
  (mongoUrl ? test : test.skip)("MongoDB migrations create the indexes", async () => {
    const database = `ss_jobs_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const root = createLinkedProject({
      "quickservice.config.ts": `import { defineConfig, mongodbAdapter } from "@quickservice/core";\nexport default defineConfig({ database: mongodbAdapter({ url: ${JSON.stringify(mongoUrl)}, database: ${JSON.stringify(database)} }) });\n`,
      "jobs/nightly.ts": JOB,
    });
    await addMigration(root, "Initial", at(0));
    await migrate(root);
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    try {
      const indexes = await client.db(database).collection("job_runs").indexes();
      expect(indexes.find((index) => index.name === "job_runs_job_scheduledAt_attempt_uq")).toMatchObject({ key: { job: 1, scheduledAt: 1, attempt: 1 }, unique: true });
      expect(indexes.find((index) => index.name === "job_runs_job_startedAt_idx")).toMatchObject({ key: { job: 1, startedAt: 1 } });
    } finally {
      await client.db(database).dropDatabase();
      await client.close();
    }
  });

  test("no routes and no entry in the API docs", async () => {
    const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "entities/User.ts": "export type User = { email: string }", "jobs/nightly.ts": JOB });
    await build(root);
    const { models } = (await import(join(root, ".generated/models.ts"))) as { models: EntityModel[] };
    const { crudRoutes } = (await import(join(root, ".generated/routes.ts"))) as { crudRoutes: { path: string }[] };
    expect(models.map((model) => model.key)).toContain("JobRun");
    expect(crudRoutes.some((route) => route.path.startsWith("/job-runs"))).toBe(false);
    const openApi = readFileSync(join(root, ".generated/openapi.json"), "utf8");
    expect(openApi).not.toContain("JobRun");
    expect(openApi).not.toContain("job-runs");
    const database = memoryAdapter();
    await database.connect(models);
    const { server } = createApp({ models, crudRoutes: crudRoutes as never, endpoints: [], hooks: new Map(), config: resolveConfig({ database, logger: silent }, {}), openApi: JSON.parse(openApi) });
    expect((await server.fetch(new Request("http://x/job-runs"))).status).toBe(404);
    expect((await server.fetch(new Request("http://x/users"))).status).toBe(200);
    const docs = (await (await server.fetch(new Request("http://x/openapi.json"))).json()) as { components: { schemas: Record<string, unknown> } };
    expect(Object.keys(docs.components.schemas).some((name) => name.startsWith("JobRun"))).toBe(false);
  });
});

describe("read-only repository", () => {
  test("generated types offer only reads", async () => {
    const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "jobs/nightly.ts": JOB });
    await build(root);
    const types = readFileSync(join(root, ".generated/types.ts"), "utf8");
    expect(types).toContain("jobRuns: ReadRepository<JobRun, JobRunReferences>;");
    expect(types).not.toContain("JobRunCreate");
    const check = join(root, "check.ts");
    writeFileSync(
      check,
      [
        'import type { GeneratedRepositories } from "./.generated/types.ts";',
        "declare const repos: GeneratedRepositories;",
        'const failed = await repos.jobRuns.where((r) => r.status.eq("failed")).all();',
        "const statuses: string[] = failed.map((run) => run.status);",
        'const latest = await repos.jobRuns.query().orderByDescending((r) => r.startedAt).take(5).all();',
        "const result: unknown = latest[0]?.result;",
        'const one = await repos.jobRuns.findById("x");',
        "const attempt: number | undefined = one?.attempt;",
        'void repos.jobRuns.findOne([]);',
        "void repos.jobRuns.list({ where: [], sort: [], limit: 10, offset: 0 });",
        "// @ts-expect-error runs are written by the framework",
        'void repos.jobRuns.create({ job: "x" });',
        "// @ts-expect-error runs are written by the framework",
        'void repos.jobRuns.update("x", {});',
        "// @ts-expect-error runs are written by the framework",
        'void repos.jobRuns.replace("x", {});',
        "// @ts-expect-error runs are written by the framework",
        'void repos.jobRuns.delete("x");',
        "// @ts-expect-error not a status",
        'void repos.jobRuns.where((r) => r.status.eq("broken"));',
        "export { statuses, result, attempt };",
        "",
      ].join("\n"),
    );
    const program = ts.createProgram([check], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["lib.esnext.d.ts"],
      types: [],
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(check));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
  });

  test("the runtime repository has only the read methods", async () => {
    const model = jobRunEntity();
    const adapter = memoryAdapter();
    await adapter.connect([model]);
    const stored = run({ status: "failed" });
    await adapter.insert(model, stored);
    const repos = createRepositories([model], adapter) as Record<string, Record<string, unknown>>;
    expect(Object.keys(repos.jobRuns!).sort()).toEqual(["findById", "findOne", "list", "query", "where"]);
    const jobRuns = repos.jobRuns as unknown as {
      findById(id: string): Promise<{ id: string } | null>;
      where(lambda: (r: { status: { eq(value: string): unknown } }) => unknown): { count(): Promise<number> };
    };
    expect((await jobRuns.findById(stored.id))?.id).toBe(stored.id);
    expect(await jobRuns.where((r) => r.status.eq("failed")).count()).toBe(1);
  });
});
