/**
 * Feature switches of benchmark runs (`bun benchmarks/run.ts quickservice --features security=off,events=on`) and the
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
}

/**
 * Variables every QuickService run starts with: the load generator is one IP, so the default rate limit would
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
  return {
    switches,
    defaults,
    variables: Object.fromEntries(keys.map((key) => [envName(key), switches[key] === "on" ? "true" : "false"])),
    label: keys.map((key) => `${key}-${switches[key]}`).join("+"),
  };
}

/** Where a run's result goes: `results/<stack>.json`, or `results/features/<label>.json` for a run with switches. */
export function resultFile(resultsDir: string, stack: string, features?: FeatureSwitches): string {
  return features ? join(resultsDir, "features", `${features.label}.json`) : join(resultsDir, `${stack}.json`);
}

/**
 * The variables a QuickService run starts with: the rate limit off, then the switches. `security=on` keeps the rate
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
 * `security=off` fails when the default security costs more than its budget on `crud`.
 */
export function compareResults(run: BenchResult, baseline: BenchResult): { lines: string[]; failures: string[] } {
  const lines: string[] = [];
  const failures: string[] = [];
  const switches = run.features?.switches ?? {};
  const defaults = run.features?.defaults ?? {};
  const keys = Object.keys(switches);
  const noiseRun = keys.length > 0 && keys.every((key) => switches[key] === "off" && defaults[key] === "off");
  const securityOff = switches.security === "off";
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
    if (securityOff && name === "crud") {
      // The run without security is the faster one: what it gains is what the default security costs.
      const cost = Math.max(throughput, (base.latencyMs.p50 / scenario.latencyMs.p50 - 1) * 100);
      if (cost > SECURITY_BUDGET) failures.push(`security costs ${Math.round(cost)}% on crud; the budget is ${SECURITY_BUDGET}%`);
    }
  }
  return { lines, failures };
}
