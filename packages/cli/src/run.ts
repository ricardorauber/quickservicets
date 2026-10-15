import { version } from "./version.ts";

export interface Output {
  log(line: string): void;
  error(line: string): void;
}

const consoleOutput: Output = { log: (line) => console.log(line), error: (line) => console.error(line) };

export async function run(args: string[], output: Output = consoleOutput, cwd = process.cwd()): Promise<number> {
  if (args.includes("--version")) {
    output.log(version);
    return 0;
  }
  const [command] = args;
  try {
    if (command === "build") {
      const { build } = await import("./build/build.ts");
      const summary = await build(cwd);
      output.log(`Built ${summary.entities} entities, ${summary.endpoints} custom endpoints and ${summary.hooks} hooks.`);
      for (const warning of summary.warnings) output.error(`Warning: ${warning}`);
      return 0;
    }
    if (command === "migrate") {
      const { migrate } = await import("./migrations/migrate.ts");
      const positional = args.slice(1).filter((arg) => !arg.startsWith("--"));
      const result = await migrate(cwd, { target: positional[0], force: args.includes("--force") });
      for (const message of result.messages) output.log(message);
      return 0;
    }
    if (command === "migration" && args[1] === "list") {
      const { listMigrationStatus } = await import("./migrations/list-remove.ts");
      const list = await listMigrationStatus(cwd);
      if (list.warning) output.error(`Warning: ${list.warning}`);
      for (const entry of list.entries) output.log(`${entry.id}  ${entry.status}`);
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
