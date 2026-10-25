import { ConfigError } from "./config-error.ts";
import type { FeatureDefinition } from "./features.ts";
import { boolean, duration, integer, list, oneOf, parseOptionString, secret, size, string, url, type AnyOptionSchema } from "./options.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import { WORKER_INDEX_ENV, workerIndex, WORKERS_ENV } from "./workers.ts";

/** The environment variable of a config path: `server.port` is `QS_SERVER_PORT`, `rate-limits.window` is `QS_RATE_LIMITS_WINDOW`. */
export function envNameFor(path: string): string {
  return `QS_${path.split(".").map(segmentName).join("_")}`;
}

/** One path segment of a variable name: `rateLimit` is `RATE_LIMIT`, `rate-limits` is `RATE_LIMITS`. */
function segmentName(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toUpperCase();
}

/** The segment of a record entry's name: matched case-insensitively, with hyphens written as underscores. */
const entryName = (entry: string) => entry.replaceAll("-", "_").toUpperCase();

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

/** One option of a schema that a variable sets, with its path and its variable's name. */
export interface OptionLeaf {
  path: string;
  schema: AnyOptionSchema;
  /** The variable's name: `envNameFor(path)`, with record entry names upper-cased as written. */
  name: string;
}

/** The value at `key` of a config value; `enabled` of a toggle written as `true` or `false`. */
function childOf(value: unknown, key: string): unknown {
  if (isObject(value)) return value[key];
  return typeof value === "boolean" && key === "enabled" ? value : undefined;
}

/**
 * The options of a schema that variables set, with their paths under `path`, parents before children: every leaf, each
 * toggle (set whole by `QS_<PATH>`) before its `enabled` and keys, and each record (set whole from JSON) before the
 * keys of its entries present in `value`. Hooks are not overridable and have no variable.
 */
export function optionLeaves(schema: AnyOptionSchema, path: string, value?: unknown): OptionLeaf[] {
  const leaves: OptionLeaf[] = [];
  const visit = (node: AnyOptionSchema, nodePath: string, name: string, current: unknown) => {
    if ((node.kind as string) === "hook") return;
    if (node.kind !== "object") leaves.push({ path: nodePath, schema: node, name });
    if (node.kind === "object" || node.kind === "toggle") {
      for (const [key, child] of Object.entries(node.settings.shape!)) visit(child, `${nodePath}.${key}`, `${name}_${segmentName(key)}`, childOf(current, key));
    } else if (node.kind === "record" && isObject(current)) {
      for (const [entry, entryValue] of Object.entries(current)) visit(node.settings.item!, `${nodePath}.${entry}`, `${name}_${entryName(entry)}`, entryValue);
    }
  };
  visit(schema, path, envNameFor(path), value);
  return leaves;
}

/**
 * The variables of a feature's options (with the record entries of `value`, the feature's config value), throwing
 * when two options would share one.
 */
export function featureVariables(key: string, schema: AnyOptionSchema, value?: unknown): Map<string, OptionLeaf> {
  const variables = new Map<string, OptionLeaf>();
  for (const leaf of optionLeaves(schema, key, value)) {
    const taken = variables.get(leaf.name);
    if (taken) throw new Error(`Invalid feature ${key}: options ${taken.path} and ${leaf.path} both map to ${leaf.name}`);
    variables.set(leaf.name, leaf);
  }
  return variables;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy of `target` with `value` at `segments`, copying every object on the way; a toggle's `true` or `false` becomes `{ enabled }`. */
function withValue(target: unknown, segments: string[], value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = isObject(target) ? { ...target } : typeof target === "boolean" ? { enabled: target } : {};
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
    const enabledName = envNameFor(`${definition.key}.enabled`);
    let enabled: boolean | undefined;
    if (set(env[enabledName])) {
      const parsed = parse(boolean(), env[enabledName]!, `${enabledName} (${definition.key}.enabled)`, problems);
      if (parsed.ok) enabled = parsed.value as boolean;
    }
    const value = config[definition.key];
    // Variables apply in order, parents first, so a whole toggle or record is set before its keys; the leaves of
    // record entries are listed from the value the record has once its own variable applied.
    let featureOptions: Record<string, unknown> = isObject(value) ? value : {};
    let changed = false;
    const applyLeaves = (schema: AnyOptionSchema, path: string, current: unknown) => {
      for (const leaf of optionLeaves(schema, path, current)) {
        if (leaf.path === `${definition.key}.enabled`) continue;
        const raw = env[leaf.name];
        if (!set(raw)) continue;
        const parsed = parse(leaf.schema, raw, `${leaf.name} (${leaf.path})`, problems);
        if (!parsed.ok) continue;
        featureOptions = withValue(featureOptions, leaf.path.split(".").slice(1), parsed.value);
        changed = true;
        if (leaf.schema.kind === "record") {
          // Entries the variable defined get their own variables, applied after it.
          const segments = leaf.path.split(".").slice(1);
          const entries = segments.reduce<unknown>((at, segment) => childOf(at, segment), featureOptions);
          for (const entry of optionLeaves(leaf.schema, leaf.path, entries)) {
            if (entry.path === leaf.path || !set(env[entry.name])) continue;
            const entryParsed = parse(entry.schema, env[entry.name]!, `${entry.name} (${entry.path})`, problems);
            if (entryParsed.ok) featureOptions = withValue(featureOptions, entry.path.split(".").slice(1), entryParsed.value);
          }
        }
      }
    };
    applyLeaves(definition.schema, definition.key, featureOptions);
    if (enabled === undefined && !changed) continue;
    if (enabled === false) {
      config = { ...config, [definition.key]: false };
      continue;
    }
    // Option variables apply to a feature that is on; on their own they do not turn it on.
    const on = enabled === true || isObject(value) || value === true || (value === undefined && definition.enabledByDefault);
    if (!on) continue;
    if (enabled === true && isObject(value) && value.enabled === false) featureOptions = { ...featureOptions, enabled: true };
    config = { ...config, [definition.key]: featureOptions };
  }

  if (problems.length > 0) throw new ConfigError(problems.join("\n"));

  return { config, warnings: unknownVariableWarnings(env, definitions, declared, config) };
}

/**
 * `Unknown environment variable …` warnings for the set `QS_*` variables that match no config key, with the closest
 * name; the record entries of `config` have variables too.
 */
export function unknownVariableWarnings(
  env: Record<string, string | undefined>,
  definitions: readonly FeatureDefinition[],
  declared: readonly string[] = [],
  config: Record<string, unknown> = {},
): string[] {
  const known = new Set<string>([...INTERNAL_VARIABLES, ...declared, ...overrideVariables(definitions, config).keys()]);
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

/**
 * Every `QS_*` variable that sets a config key, with the key: the core's, their `QS_*` aliases and every feature
 * option, with the record entries of `config`.
 */
export function overrideVariables(definitions: readonly FeatureDefinition[], config: Record<string, unknown> = {}): Map<string, { path: string; secret: boolean }> {
  const variables = new Map<string, { path: string; secret: boolean }>();
  for (const override of CONFIG_OVERRIDES) {
    const entry = { path: override.path, secret: override.schema.kind === "secret" };
    variables.set(envNameFor(override.path), entry);
    if (override.alias?.name.startsWith("QS_")) variables.set(override.alias.name, entry);
  }
  for (const definition of definitions) {
    for (const [name, leaf] of featureVariables(definition.key, definition.schema, config[definition.key])) variables.set(name, { path: leaf.path, secret: leaf.schema.kind === "secret" });
  }
  return variables;
}
