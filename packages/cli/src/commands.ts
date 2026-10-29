import { resolve } from "node:path";
import { boolean, defineCommand, integer, MIGRATIONS_TABLE_RENAMED, object, string, type CommandContext, type CommandDefinition, type JsonFields } from "@quickservicets/core";
import { buildSummaryLine } from "./build/summary-line.ts";

/** The commands of the `quickservicets` CLI, for help texts and the reference documentation. */
export interface CommandDoc {
  name: string;
  usage: string;
  description: string;
  /** The fields of its `--json` document besides `ok`, for the commands that accept `--json`. */
  json?: JsonFields;
}

/** Prints a job, env or docs command's lines, sets its `--json` fields and returns its exit code. */
const print = (
  { output, result }: Pick<CommandContext, "output" | "result">,
  outcome: { code: number; lines: string[]; errors: string[]; data?: Record<string, unknown> },
) => {
  for (const line of outcome.lines) output.log(line);
  for (const line of outcome.errors) output.error(line);
  if (outcome.data) result(outcome.data);
  return outcome.code;
};

/** The `--json` fields of `quickservicets build`. */
const BUILD_JSON: JsonFields = {
  entities: "number",
  endpoints: "number",
  hooks: "number",
  features: "number",
  fromFeatures: { endpoints: "number", hooks: "number", jobs: "number" },
  buildSteps: ["string"],
  overrides: ["string"],
  warnings: ["string"],
};

/** Every built-in command; `run.ts` dispatches through this list. */
export const BUILT_IN_COMMANDS: readonly CommandDefinition[] = [
  defineCommand({
    name: "init",
    usage: "quickservicets init [directory] [--db postgres|mongodb|sqlite|memory] [--no-agents]",
    description:
      "Creates a project, with `AGENTS.md`, `CLAUDE.md` and the Claude Code skill in `.claude/skills/quickservicets/` for coding agents; inside the QuickService.ts monorepo it also links the workspace packages and installs them.",
    args: [{ name: "directory" }],
    flags: object({
      db: string().optional().describe("The database: postgres, mongodb, sqlite or memory (asked when left out; memory when not interactive)."),
      agents: boolean().default(true).describe("Writes the agent files; `--no-agents` leaves them out."),
    }),
    async run({ args, flags, cwd, output, prompt }) {
      const { initProject, DEFAULT_DATABASE } = await import("./init/init.ts");
      const steps = await initProject(args.directory ? resolve(cwd, args.directory) : cwd, {
        db: flags.db,
        agents: flags.agents,
        prompt: (question, choices) => prompt(question, choices, { flag: "--db", default: DEFAULT_DATABASE }),
      });
      for (const line of steps) output.log(line);
      return 0;
    },
  }),
  defineCommand({
    name: "dev",
    usage: "quickservicets dev",
    description:
      "Builds and serves the project, rebuilding and restarting when entities, endpoints, hooks, jobs, features, the config, the `.env` files, or a folder or `watch` path of an enabled feature change.",
    async run({ cwd, output }) {
      const { handleSignals, startDev } = await import("./dev/dev.ts");
      const session = await startDev(cwd, { log: output.log, error: output.error });
      handleSignals(session);
      await new Promise(() => {});
    },
  }),
  defineCommand({
    name: "build",
    usage: "quickservicets build",
    description: "Generates `.generated/`: models, routes, types, the OpenAPI document and the server entry.",
    json: BUILD_JSON,
    async run({ cwd, output, result }) {
      const { build } = await import("./build/build.ts");
      const summary = await build(cwd);
      result({
        entities: summary.entities,
        endpoints: summary.endpoints,
        hooks: summary.hooks,
        features: summary.features ?? 0,
        fromFeatures: summary.fromFeatures ?? { endpoints: 0, hooks: 0, jobs: 0 },
        buildSteps: (summary.buildSteps ?? []).map((step) => step.key),
        overrides: summary.overrides ?? [],
        warnings: summary.warnings,
      });
      for (const line of summary.overrides ?? []) output.log(line);
      output.log(buildSummaryLine(summary));
      const fromFeatures = summary.fromFeatures;
      if (fromFeatures && fromFeatures.endpoints + fromFeatures.hooks + fromFeatures.jobs > 0) {
        output.log(`Features added ${fromFeatures.endpoints} endpoints, ${fromFeatures.hooks} hooks and ${fromFeatures.jobs} jobs.`);
      }
      const steps = summary.buildSteps ?? [];
      if (steps.length > 0) {
        const { buildStepLines } = await import("./build/build-steps.ts");
        for (const line of buildStepLines(steps)) output.log(line);
        output.log(`Ran ${steps.length} feature build steps.`);
      }
      for (const warning of summary.warnings) output.error(`Warning: ${warning}`);
      return 0;
    },
  }),
  defineCommand({
    name: "migrate",
    usage: "quickservicets migrate [target] [--force] [--tenant <id> | --all-tenants [--concurrency <n>] [--continue-on-error]]",
    description: "Applies pending migrations, or migrates up or down to the target migration; with tenancy, --tenant and --all-tenants migrate tenants.",
    args: [{ name: "target", description: "The migration to migrate up or down to, or 0 to revert every migration." }],
    flags: object({
      force: boolean().default(false).describe("Reverts migrations in production."),
      tenant: string().optional().describe("Applies the tenant statements of pending migrations to this tenant's schema or database."),
      allTenants: boolean().default(false).describe("Migrates the service's database, then every tenant."),
      concurrency: integer().min(1).default(4).describe("Tenants migrated at once with --all-tenants."),
      continueOnError: boolean().default(false).describe("Keeps migrating the other tenants after one fails."),
    }),
    json: { applied: ["string"], reverted: ["string"], messages: ["string"], warnings: ["string"] },
    async run({ args, flags, cwd, output, result: report }) {
      const { migrate, migrateTenants, MigrationError } = await import("./migrations/migrate.ts");
      if (flags.tenant !== undefined || flags.allTenants) {
        const tenants = await migrateTenants(cwd, { ...(flags.tenant !== undefined ? { tenant: flags.tenant } : {}), allTenants: flags.allTenants, concurrency: flags.concurrency, continueOnError: flags.continueOnError });
        report({ applied: [], reverted: [], messages: tenants.messages, warnings: [] });
        for (const message of tenants.messages) output.log(message);
        return tenants.failed.length > 0 ? 1 : 0;
      }
      const printWarnings = (warnings: string[]) => {
        for (const warning of warnings) output.error(`Warning: ${warning}`);
      };
      const result = await migrate(cwd, { target: args.target, force: flags.force }).catch((error: unknown) => {
        if (error instanceof MigrationError) printWarnings(error.warnings);
        throw error;
      });
      printWarnings(result.warnings);
      report({ applied: result.applied, reverted: result.reverted, messages: result.messages, warnings: result.warnings });
      for (const table of result.renamed) {
        output.log(JSON.stringify({ timestamp: new Date().toISOString(), message: MIGRATIONS_TABLE_RENAMED, from: table.from, to: table.to }));
      }
      for (const message of result.messages) output.log(message);
      return 0;
    },
  }),
  defineCommand({
    name: "migration add",
    usage: "quickservicets migration add <Name>",
    description: "Creates a migration from the model changes since the last one.",
    args: [{ name: "Name", required: true }],
    json: { id: "string", file: "string" },
    async run({ args, cwd, output, result }) {
      const { addMigration } = await import("./migrations/add.ts");
      const created = await addMigration(cwd, args.Name!);
      output.log(`Created ${created.file}`);
      result({ id: created.id, file: created.file });
      return 0;
    },
  }),
  defineCommand({
    name: "migration list",
    usage: "quickservicets migration list",
    description: "Lists the migrations and whether each one is applied.",
    json: { migrations: [{ id: "string", status: "string", schemas: [{ schema: "string", tenants: "number" }] }], warning: "string?" },
    async run({ cwd, output, result }) {
      const { formatSchemaCounts, listMigrationStatus } = await import("./migrations/list-remove.ts");
      const list = await listMigrationStatus(cwd);
      result({ migrations: list.entries.map((entry) => ({ ...entry, schemas: entry.schemas ?? [] })), ...(list.warning ? { warning: list.warning } : {}) });
      if (list.warning) output.error(`Warning: ${list.warning}`);
      for (const entry of list.entries) {
        output.log(`${entry.id}  ${entry.status}${entry.schemas ? `  ${formatSchemaCounts(entry.schemas)}` : ""}`);
      }
      if (list.entries.length === 0) output.log("No migrations");
      return 0;
    },
  }),
  defineCommand({
    name: "migration remove",
    usage: "quickservicets migration remove",
    description: "Removes the latest migration when it is not applied.",
    async run({ cwd, output }) {
      const { removeLatestMigration } = await import("./migrations/list-remove.ts");
      for (const file of await removeLatestMigration(cwd)) output.log(`Removed ${file}`);
      return 0;
    },
  }),
  defineCommand({
    name: "migration script",
    usage: "quickservicets migration script [from] [to] [--output <file>]",
    description: "Prints, or writes to a file, the SQL of the migrations between two points.",
    args: [{ name: "from" }, { name: "to" }],
    flags: object({ output: string().optional().describe("Writes the script to this file instead of printing it.") }),
    async run({ args, flags, cwd, output }) {
      const { migrationScript } = await import("./migrations/script.ts");
      const script = await migrationScript(cwd, { from: args.from, to: args.to });
      if (flags.output) await Bun.write(flags.output.startsWith("/") ? flags.output : `${cwd}/${flags.output}`, script);
      else output.log(script.trimEnd());
      return 0;
    },
  }),
  defineCommand({
    name: "job run",
    usage: "quickservicets job run <name> [--force] [--tenant <id>]",
    description:
      "Runs a job now in the CLI process as a `manual` run, printing its status, duration and result or error; exits with 1 unless it succeeds. `--force` runs it even while another run of the job is running.",
    args: [{ name: "name" }],
    flags: object({
      force: boolean().default(false).describe("Runs the job even while another run of it is running."),
      tenant: string().optional().describe("Runs a job with tenants: \"each\" for this tenant only."),
    }),
    async run({ args, flags, cwd, output }) {
      const { runJobCommand } = await import("./jobs/job-commands.ts");
      return print({ output, result: () => {} }, await runJobCommand(cwd, args.name, { force: flags.force, ...(flags.tenant !== undefined ? { tenant: flags.tenant } : {}) }));
    },
  }),
  defineCommand({
    name: "job list",
    usage: "quickservicets job list",
    description: "Lists every job with its schedule, time zone and next run time.",
    json: { jobs: [{ name: "string", schedule: "string", timeZone: "string", nextRun: "string?" }] },
    async run(ctx) {
      const { listJobsCommand } = await import("./jobs/job-commands.ts");
      return print(ctx, await listJobsCommand(ctx.cwd));
    },
  }),
  defineCommand({
    name: "job runs",
    usage: "quickservicets job runs <name> [--limit n]",
    description: "Lists the latest runs of a job (20 by default) with their attempt, trigger, status, start and duration.",
    args: [{ name: "name" }],
    flags: object({ limit: string().optional().describe("How many runs to list (default 20).") }),
    json: { job: "string", runs: [{ attempt: "number", trigger: "string", status: "string", startedAt: "string", durationMs: "number?" }] },
    async run(ctx) {
      const { listJobRunsCommand } = await import("./jobs/job-commands.ts");
      return print(ctx, await listJobRunsCommand(ctx.cwd, ctx.args.name, { limit: ctx.flags.limit }));
    },
  }),
  defineCommand({
    name: "eject",
    usage: "quickservicets eject <key> [--file <path>] [--dry-run] [--force]",
    description:
      "Copies an enabled native feature into `features/<key>/` as a project feature that replaces it, or with `--file` one of its entity, endpoint, hook, job or folder files into the matching project folder, where it replaces the native's file; imports of the core are rewritten to `@quickservicets/core`.",
    args: [{ name: "key", required: true, description: "The key of an enabled native feature." }],
    flags: object({
      file: string().optional().describe("Copies only this file of the native, relative to its folder (like `jobs/prune.ts`)."),
      dryRun: boolean().default(false).describe("Lists the files it would write without writing them."),
      force: boolean().default(false).describe("Overwrites files that exist."),
    }),
    async run({ args, flags, cwd, output }) {
      const { eject } = await import("./eject/eject.ts");
      for (const line of await eject(cwd, args.key!, { file: flags.file, dryRun: flags.dryRun, force: flags.force })) output.log(line);
      return 0;
    },
  }),
  defineCommand({
    name: "env check",
    usage: "quickservicets env check",
    description:
      "Checks the environment the service would start with (the process and its `.env` files): one line per declared variable with `ok`, `default`, `missing` or `invalid`, and its value unless it is a secret, then the `QS_*` overrides that are set and warnings for unknown ones. Exits with 1 when a variable is missing or invalid.",
    json: {
      variables: [{ name: "string", status: "string", value: "string?", reason: "string?" }],
      overrides: [{ variable: "string", key: "string", value: "string" }],
      warnings: ["string"],
      errors: ["string"],
    },
    async run(ctx) {
      const { envCheck } = await import("./env/env-check.ts");
      return print(ctx, await envCheck(ctx.cwd));
    },
  }),
  defineCommand({
    name: "agents update",
    usage: "quickservicets agents update",
    description:
      "Refreshes the agent files `init` wrote (`AGENTS.md`, `CLAUDE.md` and `.claude/skills/quickservicets/`) for the installed QuickService.ts version, rewriting only the part above `<!-- quickservicets:end -->` and keeping what you wrote below it; files without the marker are skipped.",
    json: { changed: ["string"], skipped: ["string"] },
    async run({ cwd, output, result }) {
      const { updateProjectAgentFiles } = await import("./agents/project.ts");
      const { changed, skipped } = updateProjectAgentFiles(cwd);
      result({ changed, skipped });
      for (const file of changed) output.log(`Updated ${file}`);
      for (const file of skipped) output.error(`${file} has no quickservicets marker; skipped`);
      if (changed.length === 0 && skipped.length === 0) output.log("The agent files are up to date");
      return 0;
    },
  }),
  defineCommand({
    name: "docs",
    usage: "quickservicets docs [topic] [--full] [--plain]",
    description:
      "Lists the agent guide topics with their summaries, or prints one; `--full` prints the full docs page the topic links to (or a page by name, like `queues`). Works offline and matches the installed version.",
    args: [{ name: "topic", description: "The topic to print, like `quickstart`." }],
    flags: object({
      full: boolean().default(false).describe("Prints the full docs page the topic links to, bundled with the CLI."),
      plain: boolean().default(false).describe("Prints without colors, as when the output is not a terminal."),
    }),
    async run({ args, flags, output }) {
      const { listTopics, printFullPage, printTopic } = await import("./agents/docs.ts");
      const color = !flags.plain && process.stdout.isTTY === true && !process.env.NO_COLOR;
      const ctx = { output, result: () => {} };
      if (!args.topic) return print(ctx, listTopics());
      return print(ctx, flags.full ? printFullPage(args.topic, { color }) : printTopic(args.topic, { color }));
    },
  }),
  defineCommand({
    name: "docs search",
    usage: "quickservicets docs search <term>",
    description: "Searches the agent guide topics and the CLI, config and tags reference, ignoring case, and prints up to 10 matching lines as `<source>: <line>`.",
    args: [{ name: "term", required: true, description: "The text to look for, like `rateLimit`." }],
    async run({ args, output }) {
      const { searchDocs } = await import("./agents/docs.ts");
      return print({ output, result: () => {} }, searchDocs(args.term!));
    },
  }),
];

export const COMMANDS: CommandDoc[] = [
  ...BUILT_IN_COMMANDS.map(({ name, usage, description, json }) => ({ name, usage, description, ...(json ? { json } : {}) })),
  { name: "--version", usage: "quickservicets --version", description: "Prints the CLI version." },
];
