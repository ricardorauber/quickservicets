import { ConfigError } from "./config-error.ts";
import type { FeatureDefinition } from "./features.ts";
import { boolean, duration, integer, list, oneOf, parseOptionString, secret, size, string, url, type AnyOptionSchema } from "./options.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import { WORKER_INDEX_ENV, workerIndex, WORKERS_ENV } from "./workers.ts";

/** The environment variable of a config path: `server.port` is `QS_SERVER_PORT`, `rate-limits.window` is `QS_RATE_LIMITS_WINDOW`. */
export function envNameFor(path: string): string {
  const segments = path.split(".").map((segment) =>
    segment
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      .replaceAll("-", "_")
      .toUpperCase(),
  );
  return `QS_${segments.join("_")}`;
}

/** A variable kept from before the `QS_*` names, which a `QS_*` variable overrides. */
export interface EnvAlias {
  name: string;
  /** Turns the alias's text into the option's text, or undefined when this value of the alias sets nothing. */
  map?: (raw: string) => string | undefined;
}

/** How one scalar key of `ServiceConfig` is read from the environment. */
export interface ConfigOverride {
  path: string;
  schema: AnyOptionSchema;
  alias?: EnvAlias;
  /** The key's own resolver reads its variables, to keep its messages (for example `server.workers` and `"auto"`). */
  custom?: true;
}

/** Every scalar key of `ServiceConfig` that an environment variable can set. */
export const CONFIG_OVERRIDES: readonly ConfigOverride[] = [
  { path: "server.port", schema: integer().min(1).max(65535), alias: { name: "PORT" } },
  { path: "server.publicUrl", schema: url() },
  { path: "server.workers", schema: string(), alias: { name: WORKERS_ENV }, custom: true },
  { path: "production", schema: boolean(), alias: { name: "NODE_ENV", map: (raw) => (raw === "production" ? "true" : undefined) } },
  { path: "docs.enabled", schema: boolean() },
  { path: "schema", schema: string(), alias: { name: "DATABASE_SCHEMA" }, custom: true },
  { path: "files.maxSize", schema: size() },
  { path: "files.accept", schema: list(string()) },
  { path: "files.access", schema: oneOf(["direct", "proxy", "signed"]) },
  { path: "files.signedUrlTtl", schema: integer().min(1) },
  { path: "files.signingSecret", schema: secret(), alias: { name: "FILES_SIGNING_SECRET" } },
  { path: "files.deleteOnRemove", schema: boolean() },
  { path: "files.deleteReplaced", schema: boolean() },
  { path: "files.deleteWithOwner", schema: boolean() },
  { path: "repositories.findAllMax", schema: integer().min(1) },
  { path: "populate.maxDepth", schema: integer().min(1) },
  { path: "migrations.autoInDev", schema: boolean() },
  { path: "jobs.enabled", schema: boolean(), alias: { name: "JOBS_ENABLED" } },
  { path: "jobs.timeZone", schema: string() },
  { path: "jobs.timeout", schema: duration() },
  { path: "jobs.retries", schema: integer().min(0) },
  { path: "jobs.retryDelay", schema: duration() },
  { path: "jobs.retention", schema: duration() },
  { path: "jobs.shutdownGrace", schema: duration() },
  { path: "jobs.limits.result", schema: size() },
  { path: "jobs.limits.logLines", schema: integer().min(1) },
  { path: "lifecycle.startTimeout", schema: duration() },
  { path: "lifecycle.stopTimeout", schema: duration() },
];

/** Keys that hold behavior (adapters, loggers, code), which no environment variable can express. */
export const NOT_OVERRIDABLE: readonly string[] = ["database", "logger", "storage", "plugins", "middleware", "env", "docs.openapi"];

/** Variables the framework sets or reads itself, which are not config overrides but are not unknown either. */
const INTERNAL_VARIABLES = [WORKER_INDEX_ENV];

/** One leaf option of a schema with its path. */
export interface OptionLeaf {
  path: string;
  schema: AnyOptionSchema;
}

/** The leaf options of a schema, with their paths under `path`. */
export function optionLeaves(schema: AnyOptionSchema, path: string): OptionLeaf[] {
  if (schema.kind !== "object") return [{ path, schema }];
  return Object.entries(schema.settings.shape!).flatMap(([key, child]) => optionLeaves(child, `${path}.${key}`));
}

/** The variables of a feature's options, throwing when two options would share one. */
export function featureVariables(key: string, schema: AnyOptionSchema): Map<string, OptionLeaf> {
  const variables = new Map<string, OptionLeaf>();
  for (const leaf of optionLeaves(schema, key)) {
    const name = envNameFor(leaf.path);
    const taken = variables.get(name);
    if (taken) throw new Error(`Invalid feature ${key}: options ${taken.path} and ${leaf.path} both map to ${name}`);
    variables.set(name, leaf);
  }
  return variables;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy of `target` with `value` at `segments`, copying every object on the way. */
function withValue(target: unknown, segments: string[], value: unknown): Record<string, unknown> {
  const copy = isObject(target) ? { ...target } : {};
  const [head, ...rest] = segments;
  copy[head!] = rest.length === 0 ? value : withValue(copy[head!], rest, value);
  return copy;
}

const set = (value: string | undefined): value is string => value !== undefined && value !== "";

/** The edit distance between two names, to suggest the variable a typo meant. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

export interface EnvironmentResult {
  /** The config with every set variable applied; the input config is never changed. */
  config: Record<string, unknown>;
  /** `Unknown environment variable …` lines. */
  warnings: string[];
}

/** Parses one variable, collecting an `Invalid <VAR> (<path>): …` problem when it does not fit the option. */
function parse(schema: AnyOptionSchema, raw: string, label: string, problems: string[]): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: parseOptionString(schema, raw, label) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(error.message);
    return { ok: false };
  }
}

/**
 * Applies the `QS_*` variables (and the legacy aliases) of the core keys and of every feature's options to `config`,
 * with the precedence variable > alias > config value; reports invalid variables in one `ConfigError` and unknown
 * `QS_*` variables as warnings. The environment is read only here, while the config is resolved.
 */
export function applyEnvironment(
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
  definitions: readonly FeatureDefinition[],
  declared: readonly string[] = [],
): EnvironmentResult {
  let config: Record<string, unknown> = input;
  const problems: string[] = [];

  for (const override of CONFIG_OVERRIDES) {
    const name = envNameFor(override.path);
    if (override.custom) continue;
    let label = `${name} (${override.path})`;
    let raw = env[name];
    if (!set(raw) && override.alias && set(env[override.alias.name])) {
      raw = override.alias.map ? override.alias.map(env[override.alias.name]!) : env[override.alias.name];
      label = `${override.alias.name} (${override.path})`;
    }
    if (!set(raw)) continue;
    const parsed = parse(override.schema, raw, label, problems);
    if (parsed.ok) config = withValue(config, override.path.split("."), parsed.value);
  }

  for (const definition of definitions) {
    const variables = featureVariables(definition.key, definition.schema);
    const enabledName = envNameFor(`${definition.key}.enabled`);
    const options: [string[], unknown][] = [];
    let enabled: boolean | undefined;
    for (const [name, leaf] of variables) {
      const raw = env[name];
      if (!set(raw)) continue;
      const parsed = parse(leaf.schema, raw, `${name} (${leaf.path})`, problems);
      if (!parsed.ok) continue;
      if (name === enabledName) enabled = parsed.value as boolean;
      else options.push([leaf.path.split(".").slice(1), parsed.value]);
    }
    if (enabled === undefined && options.length === 0) continue;
    const value = config[definition.key];
    if (enabled === false) {
      config = { ...config, [definition.key]: false };
      continue;
    }
    // Option variables apply to a feature that is on; on their own they do not turn it on.
    const on = enabled === true || isObject(value) || value === true || (value === undefined && definition.enabledByDefault);
    if (!on) continue;
    let featureOptions: Record<string, unknown> = isObject(value) ? value : {};
    for (const [segments, option] of options) featureOptions = withValue(featureOptions, segments, option);
    if (enabled === true && isObject(value) && value.enabled === false) featureOptions = { ...featureOptions, enabled: true };
    config = { ...config, [definition.key]: featureOptions };
  }

  if (problems.length > 0) throw new ConfigError(problems.join("\n"));

  return { config, warnings: unknownVariableWarnings(env, definitions, declared) };
}

/** `Unknown environment variable …` warnings for the set `QS_*` variables that match no config key, with the closest name. */
export function unknownVariableWarnings(env: Record<string, string | undefined>, definitions: readonly FeatureDefinition[], declared: readonly string[] = []): string[] {
  const known = new Set<string>([...INTERNAL_VARIABLES, ...declared, ...overrideVariables(definitions).keys()]);
  const warnings: string[] = [];
  const names = [...known];
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith("QS_") || known.has(name) || !set(env[name])) continue;
    let best: { name: string; distance: number } | undefined;
    for (const candidate of names) {
      if (!candidate.startsWith("QS_")) continue;
      const d = distance(name, candidate);
      if (d <= 2 && (!best || d < best.distance)) best = { name: candidate, distance: d };
    }
    warnings.push(`Unknown environment variable ${name}${best ? ` (did you mean ${best.name}?)` : ""}`);
  }
  return warnings;
}

/** The option variables of every core key and their aliases, for the docs. */
export function configVariable(path: string): { name: string; alias?: string } | undefined {
  const override = CONFIG_OVERRIDES.find((candidate) => candidate.path === path);
  if (!override) return undefined;
  return override.alias ? { name: envNameFor(path), alias: override.alias.name } : { name: envNameFor(path) };
}

/**
 * Logs each config warning once per service: in the process that resolves the config first (the primary, or the
 * only process), not again in every worker.
 */
export function logConfigWarnings(config: { warnings: readonly string[]; logger?: Logger }, env: Record<string, string | undefined> = process.env): void {
  if (workerIndex(env) !== undefined) return;
  for (const warning of config.warnings) safeLog(config.logger ?? jsonLogger, "warn", { timestamp: new Date().toISOString(), message: "config.warning", warning });
}

/** Every `QS_*` variable that sets a config key, with the key: the core's, their `QS_*` aliases and every feature option. */
export function overrideVariables(definitions: readonly FeatureDefinition[]): Map<string, { path: string; secret: boolean }> {
  const variables = new Map<string, { path: string; secret: boolean }>();
  for (const override of CONFIG_OVERRIDES) {
    const entry = { path: override.path, secret: override.schema.kind === "secret" };
    variables.set(envNameFor(override.path), entry);
    if (override.alias?.name.startsWith("QS_")) variables.set(override.alias.name, entry);
  }
  for (const definition of definitions) {
    for (const [name, leaf] of featureVariables(definition.key, definition.schema)) variables.set(name, { path: leaf.path, secret: leaf.schema.kind === "secret" });
  }
  return variables;
}
