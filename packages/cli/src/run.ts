import { build } from "./build/build.ts";
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
      const summary = await build(cwd);
      output.log(`Built ${summary.entities} entities, ${summary.endpoints} custom endpoints and ${summary.hooks} hooks.`);
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
