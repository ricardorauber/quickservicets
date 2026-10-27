import {
  createApp,
  createFeatureLifecycle,
  tenantRuns,
  jobRunEntity,
  jobSettings,
  loadConfig,
  nextRunTime,
  runOnDemand,
  type App,
  type EntityModel,
  type JobDefinition,
  type JobRun,
  type JobSchedule,
  type ResolvedConfig,
} from "@quickservicets/core";
import { join } from "node:path";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { scanProjectJobs } from "../build/feature-files.ts";

/** What a job command prints and the exit code it ends with. */
export interface JobCommandResult {
  code: number;
  /** Lines for standard output. */
  lines: string[];
  /** Lines for standard error. */
  errors: string[];
  /** The fields of the command's `--json` document. */
  data?: Record<string, unknown>;
}

export const DEFAULT_RUNS_LIMIT = 20;

/** The job registry of the project, imported from `jobs/` and from the job folders of its enabled features. */
export async function loadJobRegistry(projectRoot: string, features: ResolvedConfig["features"] = []): Promise<Map<string, JobDefinition>> {
  const registry = new Map<string, JobDefinition>();
  for (const entry of await scanProjectJobs(projectRoot, features)) {
    const module = (await import(entry.source ?? join(projectRoot, entry.file))) as { default: JobDefinition };
    registry.set(entry.name, module.default);
  }
  return registry;
}

function assertKnown(jobs: ReadonlyMap<string, JobDefinition>, name: string | undefined): string {
  if (name === undefined || !jobs.has(name)) throw new Error(`Unknown job ${name ?? ""}`.trimEnd());
  return name;
}

/** Connects to the configured database and runs `work` with an app holding the project's jobs. */
async function withJobApp<T>(
  projectRoot: string,
  config: ResolvedConfig,
  jobs: ReadonlyMap<string, JobDefinition>,
  work: (app: App, model: EntityModel) => Promise<T>,
): Promise<T> {
  const models = parseProjectEntities(projectRoot, config.features);
  // With tenancy, the features are set up so jobs can run for each tenant in its scope.
  const tenancy = config.features.some((feature) => feature.key === "tenancy");
  const lifecycle = tenancy ? createFeatureLifecycle({ features: config.features, config, models, worker: { index: 0, count: 1, runsScheduledWork: false }, generatedDir: join(projectRoot, ".generated") }) : undefined;
  await lifecycle?.setup();
  await config.database.connect(models, { defaultSchema: config.schema });
  try {
    const app = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config, jobs, ...(lifecycle ? { middleware: lifecycle.middleware, server: lifecycle.server } : {}) });
    return await work(app, models.find((model) => model.key === "JobRun" && model.system) ?? jobRunEntity());
  } finally {
    await tenantRuns()?.close?.();
    await lifecycle?.stop();
    await config.database.disconnect();
  }
}

const eq = (field: string, value: unknown) => ({ field, op: "eq" as const, value });

/** `quickservicets job run <name> [--force]`: runs the job in this process as a `manual` run and reports its final outcome. */
export async function runJobCommand(projectRoot: string, name: string | undefined, options: { force?: boolean; tenant?: string } = {}): Promise<JobCommandResult> {
  const config = await loadConfig(projectRoot);
  const jobs = await loadJobRegistry(projectRoot, config.features);
  const job = assertKnown(jobs, name);
  return withJobApp(projectRoot, config, jobs, async ({ jobRunner }, model) => {
    const claimed = await runOnDemand(jobRunner, { job, trigger: "manual", at: new Date(), force: options.force, ...(options.tenant !== undefined ? { tenant: options.tenant } : {}) });
    await jobRunner.idle();
    // Retries are new records of the same run time; the latest attempt holds the final outcome.
    const { data } = await config.database.findMany(model, {
      where: [eq("job", job), eq("scheduledAt", claimed.scheduledAt)],
      sort: [{ field: "attempt", direction: "desc" }],
      limit: 1,
      offset: 0,
      withTotal: false,
    });
    const final = (data[0] as unknown as JobRun | undefined) ?? claimed;
    if (final.status === "skipped") {
      return { code: 1, lines: [], errors: [`Job ${job} is already running; use --force to run it anyway`] };
    }
    const lines = [`Job ${job}: ${final.status} in ${final.durationMs ?? 0}ms`];
    const errors: string[] = [];
    if (final.status === "success") {
      if (final.result !== undefined && final.result !== null) lines.push(`Result: ${JSON.stringify(final.result)}`);
    } else if (final.error) {
      errors.push(`Error: ${final.error.message}`);
    }
    return { code: final.status === "success" ? 0 : 1, lines, errors };
  });
}

function describeSchedule(schedule: JobSchedule): string {
  if (typeof schedule === "string") return schedule;
  return "every" in schedule ? `every ${schedule.every}` : `at ${schedule.at}`;
}

/** Pads every column but the last to its widest cell. */
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  "));
}

/** `quickservicets job list`: every job with its schedule, time zone and next run time. */
export async function listJobsCommand(projectRoot: string, now: Date = new Date()): Promise<JobCommandResult> {
  const config = await loadConfig(projectRoot);
  const jobs = await loadJobRegistry(projectRoot, config.features);
  if (jobs.size === 0) return { code: 0, lines: ["No jobs"], errors: [], data: { jobs: [] } };
  const rows = [["JOB", "SCHEDULE", "TIME ZONE", "NEXT RUN"]];
  const listed: { name: string; schedule: string; timeZone: string; nextRun: string | null }[] = [];
  for (const [name, definition] of jobs) {
    const { timeZone } = jobSettings(definition.options, config.jobs);
    const next = nextRunTime(definition.schedule, timeZone, now);
    rows.push([name, describeSchedule(definition.schedule), timeZone, next ? next.toISOString() : "never"]);
    listed.push({ name, schedule: describeSchedule(definition.schedule), timeZone, nextRun: next ? next.toISOString() : null });
  }
  return { code: 0, lines: table(rows), errors: [], data: { jobs: listed } };
}

/** `quickservicets job runs <name> [--limit n]`: the latest runs of the job, newest first. */
export async function listJobRunsCommand(projectRoot: string, name: string | undefined, options: { limit?: string } = {}): Promise<JobCommandResult> {
  const limit = options.limit === undefined ? DEFAULT_RUNS_LIMIT : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const config = await loadConfig(projectRoot);
  const jobs = await loadJobRegistry(projectRoot, config.features);
  const job = assertKnown(jobs, name);
  return withJobApp(projectRoot, config, jobs, async (_app, model) => {
    const { data } = await config.database.findMany(model, {
      where: [eq("job", job)],
      sort: [
        { field: "startedAt", direction: "desc" },
        { field: "attempt", direction: "desc" },
      ],
      limit,
      offset: 0,
      withTotal: false,
    });
    if (data.length === 0) return { code: 0, lines: [`No runs of ${job}`], errors: [], data: { job, runs: [] } };
    const rows = [["ATTEMPT", "TRIGGER", "STATUS", "STARTED", "DURATION"]];
    const runs: { attempt: number; trigger: string; status: string; startedAt: string; durationMs: number | null }[] = [];
    for (const record of data as unknown as JobRun[]) {
      const duration = record.durationMs === undefined || record.durationMs === null ? "-" : `${record.durationMs}ms`;
      rows.push([String(record.attempt), record.trigger, record.status, new Date(record.startedAt).toISOString(), duration]);
      runs.push({ attempt: record.attempt, trigger: record.trigger, status: record.status, startedAt: new Date(record.startedAt).toISOString(), durationMs: record.durationMs ?? null });
    }
    return { code: 0, lines: table(rows), errors: [], data: { job, runs } };
  });
}
