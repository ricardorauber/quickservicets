import { resolve } from "node:path";
import { version } from "./version.ts";

export interface Output {
  log(line: string): void;
  error(line: string): void;
}

const consoleOutput: Output = { log: (line) => console.log(line), error: (line) => console.error(line) };

/** The job name of `job run <name>` and `job runs <name> [--limit n]`. */
function jobNameArg(args: string[]): string | undefined {
  return args.slice(2).find((arg, index, list) => !arg.startsWith("--") && list[index - 1] !== "--limit");
}

export async function run(args: string[], output: Output = consoleOutput, cwd = process.cwd()): Promise<number> {
  if (args.includes("--version")) {
    output.log(version);
    return 0;
  }
  const [command] = args;
  const print = (result: { code: number; lines: string[]; errors: string[] }) => {
    for (const line of result.lines) output.log(line);
    for (const line of result.errors) output.error(line);
    return result.code;
  };
  try {
    if (command === "build") {
      const { build } = await import("./build/build.ts");
      const summary = await build(cwd);
      for (const line of summary.overrides ?? []) output.log(line);
      output.log(
        (summary.features ?? 0) > 0
          ? `Built ${summary.entities} entities, ${summary.endpoints} custom endpoints, ${summary.hooks} hooks and ${summary.features} project features.`
          : `Built ${summary.entities} entities, ${summary.endpoints} custom endpoints and ${summary.hooks} hooks.`,
      );
      for (const warning of summary.warnings) output.error(`Warning: ${warning}`);
      return 0;
    }
    if (command === "env" && args[1] === "check") {
      const { envCheck } = await import("./env/env-check.ts");
      return print(await envCheck(cwd));
    }
    if (command === "init") {
      const { initProject } = await import("./init/init.ts");
      const dbIndex = args.indexOf("--db");
      const db = dbIndex >= 0 ? args[dbIndex + 1] : undefined;
      const directory = args.slice(1).find((arg, index, list) => !arg.startsWith("--") && list[index - 1] !== "--db");
      const steps = await initProject(directory ? resolve(cwd, directory) : cwd, { db: db ?? (dbIndex >= 0 ? "" : undefined) });
      for (const line of steps) output.log(line);
      return 0;
    }
    if (command === "dev") {
      const { handleSignals, startDev } = await import("./dev/dev.ts");
      const session = await startDev(cwd, { log: output.log, error: output.error });
      handleSignals(session);
      await new Promise(() => {});
    }
    if (command === "migrate") {
      const { migrate, MigrationError } = await import("./migrations/migrate.ts");
      const positional = args.slice(1).filter((arg) => !arg.startsWith("--"));
      const printWarnings = (warnings: string[]) => {
        for (const warning of warnings) output.error(`Warning: ${warning}`);
      };
      const result = await migrate(cwd, { target: positional[0], force: args.includes("--force") }).catch((error: unknown) => {
        if (error instanceof MigrationError) printWarnings(error.warnings);
        throw error;
      });
      printWarnings(result.warnings);
      for (const message of result.messages) output.log(message);
      return 0;
    }
    if (command === "migration" && args[1] === "list") {
      const { formatSchemaCounts, listMigrationStatus } = await import("./migrations/list-remove.ts");
      const list = await listMigrationStatus(cwd);
      if (list.warning) output.error(`Warning: ${list.warning}`);
      for (const entry of list.entries) {
        output.log(`${entry.id}  ${entry.status}${entry.schemas ? `  ${formatSchemaCounts(entry.schemas)}` : ""}`);
      }
      if (list.entries.length === 0) output.log("No migrations");
      return 0;
    }
    if (command === "migration" && args[1] === "remove") {
      const { removeLatestMigration } = await import("./migrations/list-remove.ts");
      for (const file of await removeLatestMigration(cwd)) output.log(`Removed ${file}`);
      return 0;
    }
    if (command === "migration" && args[1] === "script") {
      const { migrationScript } = await import("./migrations/script.ts");
      const outputIndex = args.indexOf("--output");
      const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      const positional = args.slice(2).filter((arg, index, list) => !arg.startsWith("--") && list[index - 1] !== "--output");
      const script = await migrationScript(cwd, { from: positional[0], to: positional[1] });
      if (outputFile) await Bun.write(outputFile.startsWith("/") ? outputFile : `${cwd}/${outputFile}`, script);
      else output.log(script.trimEnd());
      return 0;
    }
    if (command === "job" && args[1] === "run") {
      const { runJobCommand } = await import("./jobs/job-commands.ts");
      return print(await runJobCommand(cwd, jobNameArg(args), { force: args.includes("--force") }));
    }
    if (command === "job" && args[1] === "list") {
      const { listJobsCommand } = await import("./jobs/job-commands.ts");
      return print(await listJobsCommand(cwd));
    }
    if (command === "job" && args[1] === "runs") {
      const { listJobRunsCommand } = await import("./jobs/job-commands.ts");
      const limitIndex = args.indexOf("--limit");
      return print(await listJobRunsCommand(cwd, jobNameArg(args), { limit: limitIndex >= 0 ? (args[limitIndex + 1] ?? "") : undefined }));
    }
    if (command === "migration" && args[1] === "add") {
      if (!args[2]) throw new Error("Usage: quickservice migration add <Name>");
      const { addMigration } = await import("./migrations/add.ts");
      const created = await addMigration(cwd, args[2]);
      output.log(`Created ${created.file}`);
      return 0;
    }
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (command !== undefined) {
    output.error(`Unknown command: ${command}`);
    return 1;
  }
  return 0;
}
