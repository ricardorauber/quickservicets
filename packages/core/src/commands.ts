import type { ResolvedConfig } from "./config.ts";
import type { Repositories } from "./hooks.ts";
import type { AnyOptionSchema, ObjectOptionSchema, Options } from "./options.ts";

/** A positional argument of a command. */
export interface CommandArg {
  name: string;
  /** The command fails with its usage when the argument is missing (default false). */
  required?: boolean;
  /** One sentence for the help and the reference. */
  description?: string;
}

/** Where a command prints. */
export interface CommandOutput {
  log(line: string): void;
  error(line: string): void;
}

/** What a command's `run` receives. */
export interface CommandContext<F = Record<string, unknown>, O = Record<string, unknown>> {
  /** The positional arguments, by name; undefined when not given. */
  args: Record<string, string | undefined>;
  /** The flags, parsed and with their defaults. */
  flags: F;
  /** The directory the CLI runs in, the project's root. */
  cwd: string;
  /** The project's resolved configuration; for a feature's command it is loaded before the command runs. */
  config: ResolvedConfig;
  /** The options of the feature that defines the command (empty for built-in commands). */
  options: O;
  output: CommandOutput;
  /** Connects to the database with the project's generated models and returns the repositories; disconnected after `run`. */
  connect(): Promise<Repositories>;
}

/** What `defineCommand` accepts. */
export interface CommandInput<S extends AnyOptionSchema = ObjectOptionSchema<{}>> {
  /** One or more space-separated words, like `history prune`. */
  name: string;
  /** How to call it, like `quickservice history prune <entity> [--before <date>]`. */
  usage: string;
  description: string;
  args?: readonly CommandArg[];
  /** The flags, an `object({...})` schema; `--dry-run` sets the key `dryRun`. */
  flags?: S;
  run(ctx: CommandContext<Options<S>>): number | void | Promise<number | void>;
}

/** A command definition, as `defineCommand` returns it. */
export interface CommandDefinition<S extends AnyOptionSchema = AnyOptionSchema> {
  readonly name: string;
  readonly words: readonly string[];
  readonly usage: string;
  readonly description: string;
  readonly args: readonly CommandArg[];
  readonly flags?: S;
  run(ctx: CommandContext<Options<S>>): number | void | Promise<number | void>;
}

const WORD = /^[a-z][a-z0-9-]*$/;

/** Defines a `quickservice <name>` command; built-in commands and features' `commands` use it. */
export function defineCommand<S extends AnyOptionSchema = ObjectOptionSchema<{}>>(input: CommandInput<S>): CommandDefinition<S> {
  const invalid = (reason: string) => new Error(`Invalid command ${String(input?.name)}: ${reason}`);
  if (typeof input?.name !== "string") throw invalid("the name must be one or more words");
  const words = input.name.trim().split(/\s+/);
  if (!words.every((word) => WORD.test(word))) throw invalid("each word must match ^[a-z][a-z0-9-]*$");
  if (typeof input.usage !== "string" || typeof input.description !== "string") throw invalid("usage and description are required");
  if (typeof input.run !== "function") throw invalid("run must be a function");
  if (input.flags !== undefined && (input.flags.kind !== "object" || !input.flags.settings.shape)) throw invalid("flags must be an object({...}) schema");
  const args = [...(input.args ?? [])];
  for (const arg of args) if (typeof arg?.name !== "string" || arg.name === "") throw invalid("each argument needs a name");
  return Object.freeze({
    name: words.join(" "),
    words: Object.freeze(words),
    usage: input.usage,
    description: input.description,
    args: Object.freeze(args),
    ...(input.flags ? { flags: input.flags } : {}),
    run: input.run as CommandDefinition<S>["run"],
  });
}

/** Whether a value is a command definition. */
export function isCommandDefinition(value: unknown): value is CommandDefinition {
  return typeof value === "object" && value !== null && Array.isArray((value as CommandDefinition).words) && typeof (value as CommandDefinition).run === "function";
}
