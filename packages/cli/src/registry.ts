import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILE,
  ConfigError,
  closestName,
  createRepositories,
  describeOptions,
  loadConfig,
  parseOptionString,
  resolveOptions,
  type AnyOptionSchema,
  type CommandContext,
  type CommandDefinition,
  type CommandOutput,
  type EntityModel,
  type Repositories,
  type ResolvedConfig,
} from "@quickservice/core";
import { BUILT_IN_COMMANDS } from "./commands.ts";

/** Names handled before the registry, which no feature command may take. */
export const RESERVED_COMMANDS = ["help"];

/** A feature's command, with the feature's key. */
export interface FeatureCommand {
  key: string;
  command: CommandDefinition;
}

/** The enabled features' commands of a project, with its resolved config. */
export interface FeatureCommands {
  config: ResolvedConfig;
  commands: FeatureCommand[];
}

/** A command the arguments name: a built-in one, or a feature's with its key and the project's config. */
export interface ResolvedCommand {
  command: CommandDefinition;
  feature?: { key: string; config: ResolvedConfig };
}

/** Thrown for a command line the command does not accept; the CLI prints it with the command's usage. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The words of the arguments before the first flag. */
export const leadingWords = (args: readonly string[]) => {
  const end = args.findIndex((arg) => arg.startsWith("-"));
  return end < 0 ? [...args] : args.slice(0, end);
};

/** The command whose name is the longest run of leading words of the arguments. */
export function longestMatch<T extends { words: readonly string[] }>(commands: readonly T[], args: readonly string[]): T | undefined {
  const words = leadingWords(args);
  let best: T | undefined;
  for (const command of commands) {
    if (command.words.length > words.length || !command.words.every((word, index) => words[index] === word)) continue;
    if (!best || command.words.length > best.words.length) best = command;
  }
  return best;
}

/**
 * Loads the project's config without connecting, and lists the enabled features' commands; undefined outside a
 * project. Fails when a feature's command takes the name of a built-in command or of another feature's command.
 */
export async function loadFeatureCommands(cwd: string): Promise<FeatureCommands | undefined> {
  if (!existsSync(join(cwd, CONFIG_FILE))) return undefined;
  const config = await loadConfig(cwd);
  const commands: FeatureCommand[] = [];
  const owners = new Map<string, string>([...BUILT_IN_COMMANDS.map((command) => command.name), ...RESERVED_COMMANDS].map((name) => [name, "the built-in command"]));
  for (const feature of config.features) {
    for (const command of feature.definition.commands ?? []) {
      const owner = owners.get(command.name);
      if (owner) throw new Error(`Command "${command.name}" of ${feature.key} conflicts with ${owner}`);
      owners.set(command.name, feature.key);
      commands.push({ key: feature.key, command });
    }
  }
  return { config, commands };
}

/**
 * The command the arguments name: a built-in one without loading the project's config, otherwise a command of an
 * enabled feature, matching the longest name.
 */
export async function resolveCommand(
  args: readonly string[],
  cwd: string,
  loadFeatures: (cwd: string) => Promise<FeatureCommands | undefined> = loadFeatureCommands,
): Promise<{ resolved?: ResolvedCommand; features?: FeatureCommands }> {
  const builtIn = longestMatch(BUILT_IN_COMMANDS, args);
  if (builtIn) return { resolved: { command: builtIn } };
  const features = await loadFeatures(cwd);
  if (!features) return {};
  const match = longestMatch(
    features.commands.map((entry) => ({ words: entry.command.words, entry })),
    args,
  );
  return match ? { resolved: { command: match.entry.command, feature: { key: match.entry.key, config: features.config } }, features } : { features };
}

const toKey = (flag: string) => flag.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
const toFlag = (key: string) => key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

function flagShape(command: CommandDefinition): Record<string, AnyOptionSchema> {
  return (command.flags?.settings.shape ?? {}) as Record<string, AnyOptionSchema>;
}

const messageOf = (error: unknown) => (error instanceof ConfigError ? error.message : (error as Error).message);

/**
 * Parses the arguments after a command's words: positional arguments by name, and `--name value`, `--name=value`,
 * `--flag` and `--no-flag` converted with the flag schema and its defaults.
 */
export function parseInvocation(command: CommandDefinition, rest: readonly string[]): { args: Record<string, string | undefined>; flags: Record<string, unknown> } {
  const shape = flagShape(command);
  const declared = Object.keys(shape).map(toFlag);
  const positional: string[] = [];
  const raw: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (!token.startsWith("--") || token === "--") {
      positional.push(token);
      continue;
    }
    const [name = "", inline] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const negated = name.startsWith("no-") && !Object.hasOwn(shape, toKey(name)) ? name.slice(3) : undefined;
    const key = toKey(negated ?? name);
    const schema = shape[key];
    if (!schema) {
      const near = closestName(negated ?? name, declared);
      throw new UsageError(`Unknown flag --${name}${near ? ` (did you mean --${near}?)` : ""}`);
    }
    if (negated !== undefined) {
      if (schema.kind !== "boolean" || inline !== undefined) throw new UsageError(`--no-${negated} only applies to boolean flags`);
      raw[key] = false;
    } else if (inline !== undefined) raw[key] = inline;
    else if (schema.kind === "boolean") raw[key] = true;
    else {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`Missing value for --${name}`);
      raw[key] = value;
      index++;
    }
  }
  const args: Record<string, string | undefined> = {};
  command.args.forEach((arg, index) => {
    args[arg.name] = positional[index];
    if (arg.required && positional[index] === undefined) throw new UsageError(`Missing argument <${arg.name}>`);
  });
  const flags: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const value = raw[key];
    try {
      flags[key] = typeof value === "string" ? (parseOptionString(schema, value, `--${toFlag(key)}`) ?? resolveOptions(schema, undefined, `--${toFlag(key)}`)) : resolveOptions(schema, value, `--${toFlag(key)}`);
    } catch (error) {
      throw new UsageError(messageOf(error));
    }
  }
  return { args, flags };
}

/** Runs a resolved command with the arguments after its words; usage errors print the command's usage and return 1. */
export async function runCommand(resolved: ResolvedCommand, rest: readonly string[], cwd: string, output: CommandOutput): Promise<number> {
  const { command, feature } = resolved;
  let parsed: ReturnType<typeof parseInvocation>;
  try {
    parsed = parseInvocation(command, rest);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    output.error(error.message);
    output.error(`Usage: ${command.usage}`);
    return 1;
  }
  let config = feature?.config;
  let connected: ResolvedConfig | undefined;
  const context: CommandContext = {
    args: parsed.args,
    flags: parsed.flags,
    cwd,
    get config(): ResolvedConfig {
      if (!config) throw new Error(`${command.name} does not load the project's config; call ctx.connect() or load it with loadConfig`);
      return config;
    },
    options: feature ? (config!.features.find((entry) => entry.key === feature.key)?.options ?? {}) : {},
    output,
    async connect(): Promise<Repositories> {
      config ??= await loadConfig(cwd);
      const file = join(cwd, ".generated/models.ts");
      if (!existsSync(file)) throw new Error('.generated/models.ts is missing; run "quickservice build" first');
      const { models } = (await import(file)) as { models: EntityModel[] };
      if (!connected) {
        await config.database.connect(models, { defaultSchema: config.schema });
        connected = config;
      }
      return createRepositories(models, config.database, { populateMaxDepth: config.populate.maxDepth, findAllMax: config.repositories?.findAllMax }) as unknown as Repositories;
    },
  };
  try {
    const code = await command.run(context as never);
    return typeof code === "number" ? code : 0;
  } finally {
    if (connected) await connected.database.disconnect();
  }
}

/** The lines of `quickservice <command> --help`: usage, description, arguments and flags with their defaults. */
export function commandHelp(command: CommandDefinition): string[] {
  const shape = flagShape(command);
  const argLines = command.args.map((arg) => `  ${arg.name}${arg.required ? " (required)" : ""}${arg.description ? `  ${arg.description}` : ""}`);
  const flagLines = Object.entries(shape).map(([key, schema]) => {
    const [described] = describeOptions(schema, key);
    const type = described?.type ?? schema.kind;
    const fallback = described?.default === undefined ? "" : ` (default ${JSON.stringify(described.default)})`;
    return `  --${toFlag(key)}  ${type}${fallback}${described?.description ? `  ${described.description}` : ""}`;
  });
  return [
    `Usage: ${command.usage}`,
    "",
    command.description,
    ...(argLines.length > 0 ? ["", "Arguments:", ...argLines] : []),
    ...(flagLines.length > 0 ? ["", "Flags:", ...flagLines] : []),
  ];
}

/** The lines of `quickservice help`: the built-in commands, then each enabled feature's commands under its key. */
export function generalHelp(features: readonly FeatureCommand[]): string[] {
  const all = [...BUILT_IN_COMMANDS, ...features.map((entry) => entry.command)];
  const width = Math.max(...all.map((command) => command.name.length));
  const line = (command: CommandDefinition) => `  ${command.name.padEnd(width)}  ${command.description}`;
  const keys = [...new Set(features.map((entry) => entry.key))];
  return [
    "Usage: quickservice <command> [arguments] [flags]",
    "",
    "Commands:",
    ...BUILT_IN_COMMANDS.map(line),
    ...keys.flatMap((key) => ["", `${key}:`, ...features.filter((entry) => entry.key === key).map((entry) => line(entry.command))]),
    "",
    "Run quickservice <command> --help for its arguments and flags, and quickservice --version for the version.",
  ];
}

/** `Unknown command: <name>`, with `Did you mean <name>?` for a command within an edit distance of 2. */
export function unknownCommand(args: readonly string[], known: readonly CommandDefinition[]): string[] {
  const words = leadingWords(args);
  const grouped = words.length > 1 && known.some((command) => command.words.length > 1 && command.words[0] === words[0]);
  const name = grouped ? words.slice(0, 2).join(" ") : (words[0] ?? args[0] ?? "");
  const near = closestName(name, known.map((command) => command.name));
  return [`Unknown command: ${name}`, ...(near ? [`Did you mean ${near}?`] : [])];
}
