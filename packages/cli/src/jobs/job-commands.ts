import {
  createApp,
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
} from "@quickservice/core";
import { join } from "node:path";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { scanJobs } from "./scan-jobs.ts";

/** What a job command prints and the exit code it ends with. */
export interface JobCommandResult {
  code: number;
  /** Lines for standard output. */
  lines: string[];
  /** Lines for standard error. */
  errors: string[];
}

export const DEFAULT_RUNS_LIMIT = 20;

/** The job registry of the project, imported from `jobs/`. */
export async function loadJobRegistry(projectRoot: string): Promise<Map<string, JobDefinition>> {
  const registry = new Map<string, JobDefinition>();
  for (const entry of await scanJobs(projectRoot)) {
    const module = (await import(join(projectRoot, entry.file))) as { default: JobDefinition };
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
  const models = parseProjectEntities(projectRoot);
  await config.database.connect(models, { defaultSchema: config.schema });
  try {
    const app = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config, jobs });
    return await work(app, models.find((model) => model.key === "JobRun" && model.system) ?? jobRunEntity());
  } finally {
    await config.database.disconnect();
  }
}

const eq = (field: string, value: unknown) => ({ field, op: "eq" as const, value });

/** `quickservice job run <name> [--force]`: runs the job in this process as a `manual` run and reports its final outcome. */
export async function runJobCommand(projectRoot: string, name: string | undefined, options: { force?: boolean } = {}): Promise<JobCommandResult> {
  const config = await loadConfig(projectRoot);
  const jobs = await loadJobRegistry(projectRoot);
  const job = assertKnown(jobs, name);
  return withJobApp(projectRoot, config, jobs, async ({ jobRunner }, model) => {
    const claimed = await runOnDemand(jobRunner, { job, trigger: "manual", at: new Date(), force: options.force });
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

/** `quickservice job list`: every job with its schedule, time zone and next run time. */
export async function listJobsCommand(projectRoot: string, now: Date = new Date()): Promise<JobCommandResult> {
  const config = await loadConfig(projectRoot);
  const jobs = await loadJobRegistry(projectRoot);
  if (jobs.size === 0) return { code: 0, lines: ["No jobs"], errors: [] };
  const rows = [["JOB", "SCHEDULE", "TIME ZONE", "NEXT RUN"]];
  for (const [name, definition] of jobs) {
    const { timeZone } = jobSettings(definition.options, config.jobs);
    const next = nextRunTime(definition.schedule, timeZone, now);
    rows.push([name, describeSchedule(definition.schedule), timeZone, next ? next.toISOString() : "never"]);
  }
  return { code: 0, lines: table(rows), errors: [] };
}

/** `quickservice job runs <name> [--limit n]`: the latest runs of the job, newest first. */
export async function listJobRunsCommand(projectRoot: string, name: string | undefined, options: { limit?: string } = {}): Promise<JobCommandResult> {
  const limit = options.limit === undefined ? DEFAULT_RUNS_LIMIT : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const config = await loadConfig(projectRoot);
  const jobs = await loadJobRegistry(projectRoot);
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
    if (data.length === 0) return { code: 0, lines: [`No runs of ${job}`], errors: [] };
    const rows = [["ATTEMPT", "TRIGGER", "STATUS", "STARTED", "DURATION"]];
    for (const record of data as unknown as JobRun[]) {
      const duration = record.durationMs === undefined || record.durationMs === null ? "-" : `${record.durationMs}ms`;
      rows.push([String(record.attempt), record.trigger, record.status, new Date(record.startedAt).toISOString(), duration]);
    }
    return { code: 0, lines: table(rows), errors: [] };
  });
}
