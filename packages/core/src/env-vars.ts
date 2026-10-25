import { ConfigError } from "./config-error.ts";
import { maskSecrets } from "./secrets.ts";
import { expectationOf, optionTypeOf, parseOptionString, type AnyOptionSchema, type OptionSettings } from "./options.ts";

/**
 * The declared environment variables, typed: the build augments it with one property per variable of the project's
 * `env` and of its enabled features.
 */
export interface EnvVars {}

/** A variable declared by the project or by a feature. */
export interface DeclaredVariable {
  name: string;
  schema: AnyOptionSchema;
  /** `the project`, or the key of the feature that declared it. */
  owner: string;
}

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;
export const PROJECT_OWNER = "the project";

/** Checks the names of an `env` declaration: upper snake case, and never a `QS_` config override. */
export function checkVariableNames(declaration: Record<string, AnyOptionSchema> | undefined, owner: string): string[] {
  const problems: string[] = [];
  for (const [name, schema] of Object.entries(declaration ?? {})) {
    if (!VARIABLE_NAME.test(name)) problems.push(`Invalid environment variable name ${name} declared by ${owner}: use ^[A-Z][A-Z0-9_]*$`);
    else if (name.startsWith("QS_")) problems.push(`Invalid environment variable name ${name} declared by ${owner}: QS_ names are reserved for config overrides`);
    else if (typeof schema !== "object" || schema === null || typeof (schema as AnyOptionSchema).kind !== "string") {
      problems.push(`Invalid environment variable ${name} declared by ${owner}: expected an option schema like string() or integer()`);
    }
  }
  return problems;
}

/** The kind a variable is declared as, as messages name it. */
const kindOf = (schema: AnyOptionSchema) => schema.kind;

/** Merges a feature's declaration into one already declared: same kind only, keeping the first owner's description and default. */
function merge(existing: DeclaredVariable, added: DeclaredVariable, problems: string[]): DeclaredVariable {
  if (kindOf(existing.schema) !== kindOf(added.schema)) {
    problems.push(`${existing.name} is declared as ${kindOf(existing.schema)} by ${existing.owner} and as ${kindOf(added.schema)} by ${added.owner}`);
    return existing;
  }
  const settings: OptionSettings = existing.schema.settings;
  const fallback = added.schema.settings;
  const merged: OptionSettings = {
    ...settings,
    ...(settings.description === undefined && fallback.description !== undefined ? { description: fallback.description } : {}),
    ...(!settings.hasDefault && fallback.hasDefault ? { hasDefault: true, default: fallback.default } : {}),
  };
  return { ...existing, schema: { kind: existing.schema.kind, settings: Object.freeze(merged) } };
}

/** The project's variables, then those of its enabled features, merged by name. */
export function declaredVariables(
  project: Record<string, AnyOptionSchema> | undefined,
  features: readonly { key: string; env?: Readonly<Record<string, AnyOptionSchema>> }[],
): DeclaredVariable[] {
  const problems = [...checkVariableNames(project, PROJECT_OWNER), ...features.flatMap((feature) => checkVariableNames(feature.env as Record<string, AnyOptionSchema>, feature.key))];
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
  const variables = new Map<string, DeclaredVariable>();
  const add = (variable: DeclaredVariable) => {
    const existing = variables.get(variable.name);
    variables.set(variable.name, existing ? merge(existing, variable, problems) : variable);
  };
  for (const [name, schema] of Object.entries(project ?? {})) add({ name, schema, owner: PROJECT_OWNER });
  for (const feature of features) for (const [name, schema] of Object.entries(feature.env ?? {})) add({ name, schema, owner: feature.key });
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
  return [...variables.values()];
}

/** The type a missing variable is reported with: `secret` for secrets, otherwise its readable type. */
export const variableType = (schema: AnyOptionSchema): string => (schema.kind === "secret" ? "secret" : optionTypeOf(schema));

/**
 * Reads, parses and checks every declared variable; missing and invalid ones are reported together in one
 * `ConfigError` starting with `Invalid environment:`.
 */
export function readVariables(variables: readonly DeclaredVariable[], source: Record<string, string | undefined>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const { name, schema } of variables) {
    const raw = source[name];
    if (raw === undefined || raw === "") {
      if (schema.settings.hasDefault) values[name] = structuredClone(schema.settings.default);
      else if (schema.settings.optional) values[name] = undefined;
      else problems.push(`${name} is required (${variableType(schema)})`);
      continue;
    }
    try {
      values[name] = parseOptionString(schema, raw, name);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      // The value is shown as the text that was set, and never for secrets.
      const shown = schema.kind === "secret" ? "[secret]" : JSON.stringify(raw);
      const expectation = /^Invalid [^:]+: expected (.*), got /.exec(error.message.split("\n")[0]!)?.[1] ?? expectationOf(schema);
      problems.push(`${name}: expected ${expectation}, got ${shown}`);
    }
  }
  if (problems.length > 0) throw new ConfigError(["Invalid environment:", ...problems.map((problem) => `  ${problem}`)].join("\n"));
  return values;
}

let resolved = false;
/** Holds the variables as own properties, so inspecting `env` shows them, with secrets masked. */
const store: Record<string, unknown> = {};
/** The names of the stored variables declared as secrets. */
let secretNames: readonly string[] = [];

/** Stores the variables of the configuration just resolved, read through `env`; `secrets` are masked when printed. */
export function setEnvValues(values: Record<string, unknown>, secrets: readonly string[] = []): void {
  for (const name of Reflect.ownKeys(store)) delete store[name as string];
  for (const [name, value] of Object.entries(values)) Object.defineProperty(store, name, { value, enumerable: true, configurable: true, writable: false });
  secretNames = secrets.filter((name) => values[name] !== undefined);
  maskSecrets(store, secretNames);
  resolved = true;
}

/** The values of the declared secret variables of the configuration just resolved. */
export function secretVariableValues(): string[] {
  return secretNames.map((name) => store[name]).filter((value): value is string => typeof value === "string");
}

const readOnly = () => {
  throw new TypeError("env is read-only; set environment variables outside the service");
};

/**
 * The declared environment variables, parsed and typed, once a configuration has been resolved in this process.
 * Reading it before (for example at the top level of `quickservice.config.ts`) throws. Secrets read as their values
 * but print and serialize as `[secret]`.
 */
export const env: Readonly<EnvVars> = new Proxy(store as Readonly<EnvVars>, {
  get(target, name) {
    if (!resolved && typeof name === "string" && name !== "toJSON") {
      throw new Error(`env.${name} was read before the configuration was resolved; use process.env inside quickservice.config.ts`);
    }
    return Reflect.get(target, name);
  },
  set: readOnly,
  defineProperty: readOnly,
  deleteProperty: readOnly,
});

/** Forgets the stored variables; for tests of reads before resolution. */
export function clearEnvValues(): void {
  setEnvValues({});
  resolved = false;
}
