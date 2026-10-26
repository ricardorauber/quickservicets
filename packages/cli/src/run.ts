import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, LEGACY_CONFIG_FILE, LEGACY_CONFIG_MESSAGE } from "@quickservicets/core";
import { versionHeader } from "./version.ts";
import { BUILT_IN_COMMANDS } from "./commands.ts";
import { commandHelp, generalHelp, loadFeatureCommands, resolveCommand, runCommand, unknownCommand, type FeatureCommands } from "./registry.ts";

export interface Output {
  log(line: string): void;
  error(line: string): void;
}

/** The exit code of a project that still has its config file under the previous name. */
export const LEGACY_CONFIG_EXIT_CODE = 3;

const consoleOutput: Output = { log: (line) => console.log(line), error: (line) => console.error(line) };

/** The enabled features' commands for the help, or none when the project's config cannot be loaded. */
async function featuresForHelp(cwd: string, loadFeatures: (cwd: string) => Promise<FeatureCommands | undefined>, output: Output): Promise<FeatureCommands["commands"]> {
  try {
    return (await loadFeatures(cwd))?.commands ?? [];
  } catch (error) {
    output.error(`Warning: the commands of features are not listed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Runs `quickservicets <args>`: built-in commands are found without loading the project's config; other names are
 * looked up among the enabled features' commands.
 */
export async function run(
  args: string[],
  output: Output = consoleOutput,
  cwd = process.cwd(),
  loadFeatures: (cwd: string) => Promise<FeatureCommands | undefined> = loadFeatureCommands,
): Promise<number> {
  if (args.includes("--version")) {
    output.log(versionHeader);
    return 0;
  }
  if (args.length === 0) return 0;
  if (existsSync(join(cwd, LEGACY_CONFIG_FILE)) && !existsSync(join(cwd, CONFIG_FILE))) {
    output.error(LEGACY_CONFIG_MESSAGE);
    return LEGACY_CONFIG_EXIT_CODE;
  }
  try {
    if (args[0] === "help" || args[0] === "--help") {
      for (const line of generalHelp(await featuresForHelp(cwd, loadFeatures, output))) output.log(line);
      return 0;
    }
    const { resolved, features } = await resolveCommand(args, cwd, loadFeatures);
    if (!resolved) {
      const known = [...BUILT_IN_COMMANDS, ...(features?.commands ?? []).map((entry) => entry.command)];
      for (const line of unknownCommand(args, known)) output.error(line);
      return 1;
    }
    const rest = args.slice(resolved.command.words.length);
    if (rest.includes("--help")) {
      for (const line of commandHelp(resolved.command)) output.log(line);
      return 0;
    }
    return await runCommand(resolved, rest, cwd, output);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
