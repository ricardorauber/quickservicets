import {
  activeFeatureDefinitions,
  applyEnvironment,
  CONFIG_FILE,
  ConfigError,
  declaredVariables,
  expectationOf,
  loadProjectFeatures,
  overrideVariables,
  parseOptionString,
  resolveFeatures,
  SECRET_MASK,
  unknownVariableWarnings,
  type AnyOptionSchema,
  type DeclaredVariable,
  type ServiceConfig,
} from "@quickservicets/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Parses the text of a `.env` file: `NAME=value` lines, optionally `export`ed and quoted, with `#` comments. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]!] = value;
  }
  return values;
}

/**
 * The environment a service started in `projectRoot` sees: the `.env` files Bun loads (`.env`, then `.env.<NODE_ENV>`,
 * then `.env.local` except in tests), with the variables already set in the process winning over them.
 */
export function projectEnvironment(projectRoot: string, processEnv: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const mode = processEnv.NODE_ENV || "development";
  const files = [".env", `.env.${mode}`, ...(mode === "test" ? [] : [".env.local"])];
  const fromFiles: Record<string, string> = {};
  for (const name of files) {
    const file = join(projectRoot, name);
    if (existsSync(file)) Object.assign(fromFiles, parseEnvFile(readFileSync(file, "utf8")));
  }
  return { ...fromFiles, ...processEnv };
}

/** One declared variable in the `--json` document of `env check`. */
export interface VariableStatus {
  name: string;
  status: "ok" | "default" | "missing" | "invalid";
  /** Its value or default as text, masked when secret; missing when not set. */
  value?: string;
  /** Why it is invalid. */
  reason?: string;
}

export interface EnvCheckResult {
  code: number;
  lines: string[];
  errors: string[];
  /** The `--json` fields: each declared variable, each `QS_*` override set, and the warnings and errors. */
  data?: { variables: VariableStatus[]; overrides: { variable: string; key: string; value: string }[]; warnings: string[]; errors: string[] };
}

function defaultText(value: unknown): string {
  if (Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null)) return value.join(",");
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/** One status line of a declared variable: `ok`, `default`, `missing` or `invalid: <reason>`, with its value unless secret. */
function statusLine({ name, schema }: DeclaredVariable, raw: string | undefined): { line: string; ok: boolean; status: VariableStatus } {
  const secret = schema.kind === "secret";
  const shown = (text: string) => (secret ? SECRET_MASK : text);
  if (raw === undefined || raw === "") {
    if (schema.settings.hasDefault) {
      const value = shown(defaultText(schema.settings.default));
      return { line: `${name} default ${value}`, ok: true, status: { name, status: "default", value } };
    }
    if (schema.settings.optional) return { line: `${name} ok (not set)`, ok: true, status: { name, status: "ok" } };
    return { line: `${name} missing`, ok: false, status: { name, status: "missing" } };
  }
  try {
    parseOptionString(schema, raw, name);
    return { line: `${name} ok ${shown(raw)}`, ok: true, status: { name, status: "ok", value: shown(raw) } };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const expectation = /^Invalid [^:]+: expected (.*), got /.exec(error.message.split("\n")[0]!)?.[1] ?? expectationOf(schema);
    const reason = `expected ${expectation} (got ${secret ? SECRET_MASK : JSON.stringify(raw)})`;
    return { line: `${name} invalid: ${reason}`, ok: false, status: { name, status: "invalid", value: shown(raw), reason } };
  }
}

/**
 * `quickservicets env check`: the status of every declared variable, the `QS_*` overrides that are set and the unknown
 * ones, read from the environment the service would start with. Exits 1 when a variable is missing or invalid.
 */
export async function envCheck(projectRoot: string, processEnv: Record<string, string | undefined> = process.env): Promise<EnvCheckResult> {
  const environment = projectEnvironment(projectRoot, processEnv);
  const lines: string[] = [];
  const errors: string[] = [];
  const variables: VariableStatus[] = [];
  const overridesSet: { variable: string; key: string; value: string }[] = [];
  const warnings: string[] = [];
  let ok = true;
  const configFile = join(projectRoot, CONFIG_FILE);
  if (!existsSync(configFile)) return { code: 1, lines, errors: [`Config file not found: ${configFile}`] };
  await loadProjectFeatures(projectRoot);
  const config = ((await import(configFile)) as { default: ServiceConfig }).default as unknown as Record<string, unknown>;
  const definitions = activeFeatureDefinitions();

  let applied = config;
  try {
    applied = applyEnvironment(config, environment, definitions).config;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    errors.push(...error.message.split("\n"));
    ok = false;
  }
  let features: { key: string; env?: Readonly<Record<string, AnyOptionSchema>> }[] = [];
  try {
    features = resolveFeatures(applied).features.map((feature) => ({ key: feature.key, env: feature.definition.env }));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    errors.push(...error.message.split("\n"));
    ok = false;
  }
  try {
    for (const variable of declaredVariables(config.env as Record<string, AnyOptionSchema> | undefined, features)) {
      const status = statusLine(variable, environment[variable.name]);
      lines.push(status.line);
      variables.push(status.status);
      ok &&= status.ok;
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    errors.push(...error.message.split("\n"));
    ok = false;
  }

  const overrides = overrideVariables(definitions, applied);
  for (const name of Object.keys(environment).sort()) {
    const override = overrides.get(name);
    const raw = environment[name];
    if (!override || raw === undefined || raw === "") continue;
    lines.push(`${name} sets ${override.path} = ${override.secret ? SECRET_MASK : raw}`);
    overridesSet.push({ variable: name, key: override.path, value: override.secret ? SECRET_MASK : raw });
  }
  const problems = [...errors];
  for (const warning of unknownVariableWarnings(environment, definitions, [], applied)) {
    errors.push(`Warning: ${warning}`);
    warnings.push(warning);
  }
  return { code: ok ? 0 : 1, lines, errors, data: { variables, overrides: overridesSet, warnings, errors: problems } };
}
