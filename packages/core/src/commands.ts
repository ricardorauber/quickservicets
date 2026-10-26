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

/**
 * The shape of a command's `--json` document, besides `ok`: a type name (`"string"`, `"number"`, `"boolean"` or
 * `"unknown"`, with a trailing `?` when the value may be missing or null), an object of shapes, or a one-element array
 * whose element is the shape of every item.
 */
export type JsonShape = string | { readonly [key: string]: JsonShape } | readonly [JsonShape];

/** The fields of a command's `--json` document, besides `ok`. */
export type JsonFields = { readonly [key: string]: JsonShape };

/** How a command asks a question: the flag that answers it, and the answer taken when no one can be asked. */
export interface PromptOptions {
  /** The flag that answers the question on the command line, like `--db`. */
  flag: string;
  /** The safe answer taken when the CLI is not interactive; without one, the command exits 2 naming `flag`. */
  default?: string;
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
  /** True when the command runs with `--json` (only for commands that declare `json`); `output.log` then goes to stderr. */
  json: boolean;
  /** Sets the fields of the `--json` document; ignored without `--json`. */
  result(data: Record<string, unknown>): void;
  /**
   * Asks a question with fixed choices. When stdin is not a terminal, `--yes` is given or `CI=true` is set, it takes
   * `options.default` without asking, or fails (exit 2) with `<command> needs <flag> when not interactive`.
   */
  prompt(question: string, choices: readonly string[], options: PromptOptions): Promise<string>;
}

/** What `defineCommand` accepts. */
export interface CommandInput<S extends AnyOptionSchema = ObjectOptionSchema<{}>> {
  /** One or more space-separated words, like `history prune`. */
  name: string;
  /** How to call it, like `quickservicets history prune <entity> [--before <date>]`. */
  usage: string;
  description: string;
  args?: readonly CommandArg[];
  /** The flags, an `object({...})` schema; `--dry-run` sets the key `dryRun`. */
  flags?: S;
  /** The fields of its `--json` document besides `ok`; a command without it does not accept `--json`. */
  json?: JsonFields;
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
  readonly json?: JsonFields;
  run(ctx: CommandContext<Options<S>>): number | void | Promise<number | void>;
}

const WORD = /^[a-z][a-z0-9-]*$/;

/** Defines a `quickservicets <name>` command; built-in commands and features' `commands` use it. */
export function defineCommand<S extends AnyOptionSchema = ObjectOptionSchema<{}>>(input: CommandInput<S>): CommandDefinition<S> {
  const invalid = (reason: string) => new Error(`Invalid command ${String(input?.name)}: ${reason}`);
  if (typeof input?.name !== "string") throw invalid("the name must be one or more words");
  const words = input.name.trim().split(/\s+/);
  if (!words.every((word) => WORD.test(word))) throw invalid("each word must match ^[a-z][a-z0-9-]*$");
  if (typeof input.usage !== "string" || typeof input.description !== "string") throw invalid("usage and description are required");
  if (typeof input.run !== "function") throw invalid("run must be a function");
  if (input.flags !== undefined && (input.flags.kind !== "object" || !input.flags.settings.shape)) throw invalid("flags must be an object({...}) schema");
  if (input.json !== undefined && (typeof input.json !== "object" || input.json === null || Object.hasOwn(input.json, "ok"))) throw invalid("json must be an object of field shapes without ok");
  const args = [...(input.args ?? [])];
  for (const arg of args) if (typeof arg?.name !== "string" || arg.name === "") throw invalid("each argument needs a name");
  return Object.freeze({
    name: words.join(" "),
    words: Object.freeze(words),
    usage: input.usage,
    description: input.description,
    args: Object.freeze(args),
    ...(input.flags ? { flags: input.flags } : {}),
    ...(input.json ? { json: input.json } : {}),
    run: input.run as CommandDefinition<S>["run"],
  });
}

/** Whether a value is a command definition. */
export function isCommandDefinition(value: unknown): value is CommandDefinition {
  return typeof value === "object" && value !== null && Array.isArray((value as CommandDefinition).words) && typeof (value as CommandDefinition).run === "function";
}

const TYPE_NAMES = ["string", "number", "boolean", "unknown"];

/**
 * What in `value` does not match `shape`, as `<path>: <problem>` lines; an empty list when it matches. Extra fields are
 * reported too, so a document says exactly what its shape documents.
 */
export function jsonShapeProblems(value: unknown, shape: JsonShape, path = "$"): string[] {
  if (typeof shape === "string") {
    const optional = shape.endsWith("?");
    const type = optional ? shape.slice(0, -1) : shape;
    if (!TYPE_NAMES.includes(type)) return [`${path}: unknown type ${shape} in the shape`];
    if (value === undefined || value === null) return optional ? [] : [`${path}: missing ${type}`];
    if (type === "unknown" || typeof value === type) return [];
    return [`${path}: expected ${type}, got ${Array.isArray(value) ? "array" : typeof value}`];
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [`${path}: expected an array`];
    return value.flatMap((item, index) => jsonShapeProblems(item, shape[0] as JsonShape, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: expected an object`];
  const fields = shape as { readonly [key: string]: JsonShape };
  const record = value as Record<string, unknown>;
  return [
    ...Object.entries(fields).flatMap(([key, field]) => jsonShapeProblems(record[key], field, `${path}.${key}`)),
    ...Object.keys(record).filter((key) => !Object.hasOwn(fields, key)).map((key) => `${path}.${key}: not in the shape`),
  ];
}
