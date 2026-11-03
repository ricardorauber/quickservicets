/**
 * Feature switches of benchmark runs (`bun benchmarks/run.ts quickservicets --features security=off,events=on`) and the
 * comparison of a run with the baseline (`bun benchmarks/compare-features.ts`).
 */
import { join } from "node:path";

/** What the runner needs of a native: its key, whether it is on without a config key and the natives it turns on. */
export interface BenchNative {
  key: string;
  enabledByDefault: boolean;
  /** The natives it turns on when it is on, like `webhooks` turning on `events` and `queues`. */
  enables?: readonly string[];
}

/** The parsed `--features` option. */
export interface FeatureSwitches {
  /** Each named native, on or off. */
  switches: Record<string, "on" | "off">;
  /** Whether each named native is on by default, recorded so a comparison knows what the run changed. */
  defaults: Record<string, "on" | "off">;
  /** The `QS_<KEY>_ENABLED` variables the service starts with. */
  variables: Record<string, string>;
  /** The natives a switch turned on through `enables`, by the switch that did, like `{ events: "webhooks" }`. */
  enabledBy: Record<string, string>;
  /** The switches sorted and joined by `+`, like `events-on+security-off`: the result file's name. */
  label: string;
  /**
   * What the run does besides the variables: migrate every tenant before the load, build the service with the switches
   * and create the tables of the natives they turn on, and headers on every request.
   */
  plan: { migrateAllTenants: boolean; nativeTables: boolean; headers: Record<string, string> };
}

/** What a switch turned on needs besides `QS_<KEY>_ENABLED`: more variables, steps before the load and request headers. */
export interface SwitchExtras {
  variables?: Record<string, string>;
  /** Runs `quickservicets migrate --all-tenants` before the load. */
  migrateAllTenants?: boolean;
  /**
   * Builds the service image with the switches on and creates the tables of the natives' entities before the load:
   * the benchmark service's own build has no feature on, so a native with entities would find none.
   */
  nativeTables?: boolean;
  headers?: Record<string, string>;
}

/**
 * The extras of the switches that need more than their variable: `tenancy=on` serves one config tenant, `bench`, with
 * the schema strategy, migrated before the load and named by every request; `queues=on`, also when a switch like
 * `webhooks=on` turns it on, needs its tables.
 */
export const SWITCH_EXTRAS: Readonly<Record<string, SwitchExtras>> = {
  tenancy: { variables: { QS_TENANCY_SOURCE: "config", QS_TENANCY_TENANTS: '{"bench":{}}' }, migrateAllTenants: true, headers: { "x-tenant-id": "bench" } },
  queues: { nativeTables: true },
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
  const enabledBy: Record<string, string> = {};
  for (const key of keys) {
    if (switches[key] !== "on") continue;
    for (const enabled of known.get(key)!.enables ?? []) if (switches[enabled] === undefined && enabledBy[enabled] === undefined) enabledBy[enabled] = key;
  }
  const extras = [...keys.filter((key) => switches[key] === "on"), ...Object.keys(enabledBy)].map((key) => SWITCH_EXTRAS[key] ?? {});
  return {
    switches,
    defaults,
    variables: Object.assign(Object.fromEntries(keys.map((key) => [envName(key), switches[key] === "on" ? "true" : "false"])), ...extras.map((extra) => extra.variables ?? {})),
    label: keys.map((key) => `${key}-${switches[key]}`).join("+"),
    enabledBy,
    plan: { migrateAllTenants: extras.some((extra) => extra.migrateAllTenants === true), nativeTables: extras.some((extra) => extra.nativeTables === true), headers: Object.assign({}, ...extras.map((extra) => extra.headers ?? {})) },
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
  features?: { switches: Record<string, "on" | "off">; defaults: Record<string, "on" | "off">; enabledBy?: Record<string, string> };
  scenarios?: Record<string, ScenarioResult>;
}

/**
 * The natives that must cost nothing beyond the natives they turn on, compared with a run that switches those on: with
 * no deliverable event, `webhooks` registers no listener and starts nothing of its own.
 */
export const OVER_ENABLED_BUDGETS: Readonly<Record<string, number>> = { webhooks: NOISE_BUDGET };

/** `events and queues`: a list of keys as a sentence. */
const listed = (keys: readonly string[]) => (keys.length <= 1 ? keys.join("") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`);

/**
 * The native a run turns on alone and the natives it turns on, when the baseline is a run with exactly those natives
 * switched on and the native has a budget over them.
 */
function overEnabled(run: BenchResult, baseline: BenchResult): { key: string; enabled: string[]; budget: number } | undefined {
  const switches = run.features?.switches ?? {};
  const on = Object.keys(switches).filter((key) => switches[key] === "on");
  if (on.length !== 1 || Object.keys(switches).length !== 1) return undefined;
  const key = on[0]!;
  const budget = OVER_ENABLED_BUDGETS[key];
  if (budget === undefined) return undefined;
  const enabledBy = run.features?.enabledBy ?? {};
  const enabled = Object.keys(enabledBy).filter((name) => enabledBy[name] === key).sort();
  const base = baseline.features?.switches ?? {};
  const baseOn = Object.keys(base).filter((name) => base[name] === "on").sort();
  if (enabled.length === 0 || baseOn.length !== Object.keys(base).length || baseOn.join(",") !== enabled.join(",")) return undefined;
  return { key, enabled, budget };
}

const percent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

/**
 * Compares a run with the baseline, scenario by scenario: the change of requests per second and of p50 and p99
 * latency. A run that only switches off features that are off by default fails above the noise budget; a run with
 * `security=off` fails when the default security costs more than its budget on `crud`; a run turning on natives with
 * an on-budget fails when they cost more than it on `crud`; a run turning on `webhooks` alone, compared with a run that
 * turns on the natives it enables, fails when it costs more than the noise budget over them on any scenario.
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
  const over = overEnabled(run, baseline);
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
    if (over) {
      const cost = Math.max(-throughput, p50);
      if (cost > over.budget) failures.push(`${over.key} costs ${Math.round(cost * 10) / 10}% over ${listed(over.enabled)} on ${name}; the budget is ${over.budget}%`);
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
