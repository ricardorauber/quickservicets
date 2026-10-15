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
