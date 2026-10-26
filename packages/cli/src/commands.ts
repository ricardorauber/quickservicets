import { resolve } from "node:path";
import { boolean, defineCommand, MIGRATIONS_TABLE_RENAMED, object, string, type CommandDefinition, type CommandOutput } from "@quickservicets/core";

/** The commands of the `quickservicets` CLI, for help texts and the reference documentation. */
export interface CommandDoc {
  name: string;
  usage: string;
  description: string;
}

/** Prints a job or env command's lines and returns its exit code. */
const print = (output: CommandOutput, result: { code: number; lines: string[]; errors: string[] }) => {
  for (const line of result.lines) output.log(line);
  for (const line of result.errors) output.error(line);
  return result.code;
};

/** Every built-in command; `run.ts` dispatches through this list. */
export const BUILT_IN_COMMANDS: readonly CommandDefinition[] = [
  defineCommand({
    name: "init",
    usage: "quickservicets init [directory] [--db postgres|mongodb|sqlite|memory]",
    description: "Creates a project; inside the QuickService.ts monorepo it also links the workspace packages and installs them.",
    args: [{ name: "directory" }],
    flags: object({ db: string().optional().describe("The database: postgres, mongodb, sqlite or memory (asked when left out).") }),
    async run({ args, flags, cwd, output }) {
      const { initProject } = await import("./init/init.ts");
      const steps = await initProject(args.directory ? resolve(cwd, args.directory) : cwd, { db: flags.db });
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
    async run({ cwd, output }) {
      const { build } = await import("./build/build.ts");
      const summary = await build(cwd);
      for (const line of summary.overrides ?? []) output.log(line);
      output.log(
        (summary.features ?? 0) > 0
          ? `Built ${summary.entities} entities, ${summary.endpoints} custom endpoints, ${summary.hooks} hooks and ${summary.features} project features.`
          : `Built ${summary.entities} entities, ${summary.endpoints} custom endpoints and ${summary.hooks} hooks.`,
      );
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
    usage: "quickservicets migrate [target] [--force]",
    description: "Applies pending migrations, or migrates up or down to the target migration.",
    args: [{ name: "target", description: "The migration to migrate up or down to, or 0 to revert every migration." }],
    flags: object({ force: boolean().default(false).describe("Reverts migrations in production.") }),
    async run({ args, flags, cwd, output }) {
      const { migrate, MigrationError } = await import("./migrations/migrate.ts");
      const printWarnings = (warnings: string[]) => {
        for (const warning of warnings) output.error(`Warning: ${warning}`);
      };
      const result = await migrate(cwd, { target: args.target, force: flags.force }).catch((error: unknown) => {
        if (error instanceof MigrationError) printWarnings(error.warnings);
        throw error;
      });
      printWarnings(result.warnings);
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
    args: [{ name: "Name" }],
    async run({ args, cwd, output }) {
      if (!args.Name) throw new Error("Usage: quickservicets migration add <Name>");
      const { addMigration } = await import("./migrations/add.ts");
      const created = await addMigration(cwd, args.Name);
      output.log(`Created ${created.file}`);
      return 0;
    },
  }),
  defineCommand({
    name: "migration list",
    usage: "quickservicets migration list",
    description: "Lists the migrations and whether each one is applied.",
    async run({ cwd, output }) {
      const { formatSchemaCounts, listMigrationStatus } = await import("./migrations/list-remove.ts");
      const list = await listMigrationStatus(cwd);
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
    usage: "quickservicets job run <name> [--force]",
    description:
      "Runs a job now in the CLI process as a `manual` run, printing its status, duration and result or error; exits with 1 unless it succeeds. `--force` runs it even while another run of the job is running.",
    args: [{ name: "name" }],
    flags: object({ force: boolean().default(false).describe("Runs the job even while another run of it is running.") }),
    async run({ args, flags, cwd, output }) {
      const { runJobCommand } = await import("./jobs/job-commands.ts");
      return print(output, await runJobCommand(cwd, args.name, { force: flags.force }));
    },
  }),
  defineCommand({
    name: "job list",
    usage: "quickservicets job list",
    description: "Lists every job with its schedule, time zone and next run time.",
    async run({ cwd, output }) {
      const { listJobsCommand } = await import("./jobs/job-commands.ts");
      return print(output, await listJobsCommand(cwd));
    },
  }),
  defineCommand({
    name: "job runs",
    usage: "quickservicets job runs <name> [--limit n]",
    description: "Lists the latest runs of a job (20 by default) with their attempt, trigger, status, start and duration.",
    args: [{ name: "name" }],
    flags: object({ limit: string().optional().describe("How many runs to list (default 20).") }),
    async run({ args, flags, cwd, output }) {
      const { listJobRunsCommand } = await import("./jobs/job-commands.ts");
      return print(output, await listJobRunsCommand(cwd, args.name, { limit: flags.limit }));
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
    async run({ cwd, output }) {
      const { envCheck } = await import("./env/env-check.ts");
      return print(output, await envCheck(cwd));
    },
  }),
];

export const COMMANDS: CommandDoc[] = [
  ...BUILT_IN_COMMANDS.map(({ name, usage, description }) => ({ name, usage, description })),
  { name: "--version", usage: "quickservicets --version", description: "Prints the CLI version." },
];
