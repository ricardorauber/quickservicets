/**
 * Feature switches of benchmark runs (`bun benchmarks/run.ts quickservicets --features security=off,events=on`) and the
 * comparison of a run with the baseline (`bun benchmarks/compare-features.ts`).
 */
import { join } from "node:path";

/** What the runner needs of a native: its key and whether it is on without a config key. */
export interface BenchNative {
  key: string;
  enabledByDefault: boolean;
}

/** The parsed `--features` option. */
export interface FeatureSwitches {
  /** Each named native, on or off. */
  switches: Record<string, "on" | "off">;
  /** Whether each named native is on by default, recorded so a comparison knows what the run changed. */
  defaults: Record<string, "on" | "off">;
  /** The `QS_<KEY>_ENABLED` variables the service starts with. */
  variables: Record<string, string>;
  /** The switches sorted and joined by `+`, like `events-on+security-off`: the result file's name. */
  label: string;
  /** What the run does besides the variables: migrate every tenant before the load, and headers on every request. */
  plan: { migrateAllTenants: boolean; headers: Record<string, string> };
}

/** What a switch turned on needs besides `QS_<KEY>_ENABLED`: more variables, steps before the load and request headers. */
export interface SwitchExtras {
  variables?: Record<string, string>;
  /** Runs `quickservicets migrate --all-tenants` before the load. */
  migrateAllTenants?: boolean;
  headers?: Record<string, string>;
}

/**
 * The extras of the switches that need more than their variable: `tenancy=on` serves one config tenant, `bench`, with
 * the schema strategy, migrated before the load and named by every request.
 */
export const SWITCH_EXTRAS: Readonly<Record<string, SwitchExtras>> = {
  tenancy: { variables: { QS_TENANCY_SOURCE: "config", QS_TENANCY_TENANTS: '{"bench":{}}' }, migrateAllTenants: true, headers: { "x-tenant-id": "bench" } },
};

/**
 * Variables every QuickService.ts run starts with: the load generator is one IP, so the default rate limit would
 * measure 429 responses. A run with `--features security=on` keeps it on, to measure it.
 */
export const QUICKSERVICE_RUN_VARIABLES: Readonly<Record<string, string>> = { QS_SECURITY_RATE_LIMIT_ENABLED: "false" };

const envName = (key: string) => `QS_${key.replaceAll("-", "_").toUpperCase()}_ENABLED`;

/** Parses `security=off,events=on` against the registered natives; throws `Unknown feature <key>; known: <keys>`. */
export function parseFeatures(text: string, natives: readonly BenchNative[]): FeatureSwitches {
  const known = new Map(natives.map((native) => [native.key, native]));
  const switches: Record<string, "on" | "off"> = {};
  const defaults: Record<string, "on" | "off"> = {};
  for (const item of text.split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = /^([a-z][a-z0-9-]*)=(on|off)$/.exec(item);
    if (!match) throw new Error(`Invalid --features item "${item}"; write <key>=on or <key>=off`);
    const [, key, state] = match as unknown as [string, string, "on" | "off"];
    const native = known.get(key);
    if (!native) throw new Error(`Unknown feature ${key}; known: ${[...known.keys()].sort().join(", ") || "none"}`);
    switches[key] = state;
    defaults[key] = native.enabledByDefault ? "on" : "off";
  }
  const keys = Object.keys(switches).sort();
  const extras = keys.filter((key) => switches[key] === "on").map((key) => SWITCH_EXTRAS[key] ?? {});
  return {
    switches,
    defaults,
    variables: Object.assign(Object.fromEntries(keys.map((key) => [envName(key), switches[key] === "on" ? "true" : "false"])), ...extras.map((extra) => extra.variables ?? {})),
    label: keys.map((key) => `${key}-${switches[key]}`).join("+"),
    plan: { migrateAllTenants: extras.some((extra) => extra.migrateAllTenants === true), headers: Object.assign({}, ...extras.map((extra) => extra.headers ?? {})) },
  };
}

/** Where a run's result goes: `results/<stack>.json`, or `results/features/<label>.json` for a run with switches. */
export function resultFile(resultsDir: string, stack: string, features?: FeatureSwitches): string {
  return features ? join(resultsDir, "features", `${features.label}.json`) : join(resultsDir, `${stack}.json`);
}

/**
 * The variables a QuickService.ts run starts with: the rate limit off, then the switches. `security=on` keeps the rate
 * limit on, which is how it is measured.
 */
export function quickServiceVariables(features?: FeatureSwitches): Record<string, string> {
  const base = features?.switches.security === "on" ? {} : QUICKSERVICE_RUN_VARIABLES;
  return { ...base, ...(features?.variables ?? {}) };
}

/** Throughput and p50 budget of features that are off by default and switched off: run-to-run noise. */
export const NOISE_BUDGET = 3;
/** What the default security may cost on `crud`, in throughput and p50 latency. */
export const SECURITY_BUDGET = 5;

/**
 * What a native switched on may cost on `crud`, in throughput and p50 latency: the infrastructure natives without
 * providers, routes, references or files must cost nothing beyond noise, tenancy with the schema strategy at most 10%.
 */
export const ON_BUDGETS: Readonly<Record<string, number>> = { metrics: 3, auth: 3, proxy: 3, secrets: 3, realtime: 3, tenancy: 10 };
/** p50 budgets that differ from the on-budget: recording every request costs `metrics` about 0.2 ms at p50. */
export const ON_P50_BUDGETS: Readonly<Record<string, number>> = { metrics: 4 };

interface ScenarioResult {
  reqPerSec: number;
  latencyMs: { p50: number; p99: number };
}

/** The parts of a result file a comparison reads. */
export interface BenchResult {
  features?: { switches: Record<string, "on" | "off">; defaults: Record<string, "on" | "off"> };
  scenarios?: Record<string, ScenarioResult>;
}

const percent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

/**
 * Compares a run with the baseline, scenario by scenario: the change of requests per second and of p50 and p99
 * latency. A run that only switches off features that are off by default fails above the noise budget; a run with
 * `security=off` fails when the default security costs more than its budget on `crud`; a run turning on natives with
 * an on-budget fails when they cost more than it on `crud`.
 */
export function compareResults(run: BenchResult, baseline: BenchResult): { lines: string[]; failures: string[] } {
  const lines: string[] = [];
  const failures: string[] = [];
  const switches = run.features?.switches ?? {};
  const defaults = run.features?.defaults ?? {};
  const keys = Object.keys(switches);
  const noiseRun = keys.length > 0 && keys.every((key) => switches[key] === "off" && defaults[key] === "off");
  const securityOff = switches.security === "off";
  // A run turning on only natives with an on-budget is held to the largest of their budgets.
  const on = keys.filter((key) => switches[key] === "on" && defaults[key] === "off");
  const budgeted = on.length > 0 && on.every((key) => ON_BUDGETS[key] !== undefined) && keys.every((key) => switches[key] === "on" || defaults[key] === "off");
  const onBudget = budgeted ? Math.max(...on.map((key) => ON_BUDGETS[key]!)) : undefined;
  const onP50Budget = budgeted ? Math.max(...on.map((key) => ON_P50_BUDGETS[key] ?? ON_BUDGETS[key]!)) : undefined;
  for (const [name, scenario] of Object.entries(run.scenarios ?? {})) {
    const base = baseline.scenarios?.[name];
    if (!base) continue;
    const throughput = (scenario.reqPerSec / base.reqPerSec - 1) * 100;
    const p50 = (scenario.latencyMs.p50 / base.latencyMs.p50 - 1) * 100;
    const p99 = (scenario.latencyMs.p99 / base.latencyMs.p99 - 1) * 100;
    lines.push(`${name}: req/s ${percent(throughput)}, p50 ${percent(p50)}, p99 ${percent(p99)}`);
    if (noiseRun) {
      if (-throughput > NOISE_BUDGET) failures.push(`${name}: throughput is ${(-throughput).toFixed(1)}% lower than the baseline; the noise budget is ${NOISE_BUDGET}%`);
      if (p50 > NOISE_BUDGET) failures.push(`${name}: p50 latency is ${p50.toFixed(1)}% higher than the baseline; the noise budget is ${NOISE_BUDGET}%`);
    }
    if (onBudget !== undefined && onP50Budget !== undefined && name === "crud") {
      const label = [...on].sort().join("+");
      if (onP50Budget === onBudget) {
        const cost = Math.max(-throughput, p50);
        if (cost > onBudget) failures.push(`${label} costs ${Math.round(cost * 10) / 10}% on crud; the budget is ${onBudget}%`);
      } else {
        if (-throughput > onBudget) failures.push(`${label} costs ${Math.round(-throughput * 10) / 10}% on crud; the budget is ${onBudget}%`);
        if (p50 > onP50Budget) failures.push(`${label} costs ${Math.round(p50 * 10) / 10}% p50 on crud; the budget is ${onP50Budget}%`);
      }
    }
    if (securityOff && name === "crud") {
      // The run without security is the faster one: what it gains is what the default security costs.
      const cost = Math.max(throughput, (base.latencyMs.p50 / scenario.latencyMs.p50 - 1) * 100);
      if (cost > SECURITY_BUDGET) failures.push(`security costs ${Math.round(cost)}% on crud; the budget is ${SECURITY_BUDGET}%`);
    }
  }
  return { lines, failures };
}
