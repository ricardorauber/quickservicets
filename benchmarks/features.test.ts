import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compareResults, parseFeatures, quickServiceVariables, resultFile, type BenchResult } from "./features.ts";

const natives = [
  { key: "security", enabledByDefault: true },
  { key: "events", enabledByDefault: false },
  { key: "history", enabledByDefault: false },
];

const scenario = (reqPerSec: number, p50: number, p99 = p50 * 3) => ({ reqPerSec, latencyMs: { p50, p99 } });
const baseline: BenchResult = { scenarios: { crud: scenario(1000, 10), query: scenario(500, 20) } };
const run = (switches: Record<string, "on" | "off">, scenarios: BenchResult["scenarios"]): BenchResult => ({
  features: { switches, defaults: Object.fromEntries(Object.keys(switches).map((key) => [key, key === "security" ? "on" : "off"])) },
  scenarios,
});

describe("--features", () => {
  test("switches become QS_<KEY>_ENABLED variables and a sorted label", () => {
    const parsed = parseFeatures("security=off,events=on", natives);
    expect(parsed.variables).toEqual({ QS_EVENTS_ENABLED: "true", QS_SECURITY_ENABLED: "false" });
    expect(parsed.label).toBe("events-on+security-off");
    expect(parsed.defaults).toEqual({ security: "on", events: "off" });
    expect(resultFile("/r", "quickservicets", parsed)).toBe(join("/r", "features", "events-on+security-off.json"));
  });

  test("unknown keys and malformed items stop the run", () => {
    expect(() => parseFeatures("nope=on", natives)).toThrow("Unknown feature nope; known: events, history, security");
    expect(() => parseFeatures("events", natives)).toThrow('Invalid --features item "events"');
  });

  test("without switches the result file is unchanged, and every QuickService.ts run turns the rate limit off", () => {
    expect(resultFile("/r", "quickservicets")).toBe(join("/r", "quickservicets.json"));
    expect(quickServiceVariables()).toEqual({ QS_SECURITY_RATE_LIMIT_ENABLED: "false" });
    expect(quickServiceVariables(parseFeatures("events=on", natives))).toEqual({ QS_SECURITY_RATE_LIMIT_ENABLED: "false", QS_EVENTS_ENABLED: "true" });
    expect(quickServiceVariables(parseFeatures("security=on", natives))).toEqual({ QS_SECURITY_ENABLED: "true" });
  });
});

describe("compare-features", () => {
  test("a run 2% slower is within the noise budget, with the percentages printed", () => {
    const { lines, failures } = compareResults(run({ events: "off" }, { crud: scenario(980, 10.2), query: scenario(490, 20.4) }), baseline);
    expect(failures).toEqual([]);
    expect(lines).toEqual(["crud: req/s -2.0%, p50 +2.0%, p99 +2.0%", "query: req/s -2.0%, p50 +2.0%, p99 +2.0%"]);
  });

  test("a run 4% slower on query fails naming the scenario and the metric", () => {
    const { failures } = compareResults(run({ events: "off", history: "off" }, { crud: scenario(1000, 10), query: scenario(480, 20) }), baseline);
    expect(failures).toEqual(["query: throughput is 4.0% lower than the baseline; the noise budget is 3%"]);
  });

  test("a run turning a feature on is only reported", () => {
    expect(compareResults(run({ events: "on" }, { crud: scenario(500, 30) }), baseline).failures).toEqual([]);
  });

  test("security off 7% faster on crud fails the security budget; 4% passes", () => {
    expect(compareResults(run({ security: "off" }, { crud: scenario(1070, 10) }), baseline).failures).toEqual(["security costs 7% on crud; the budget is 5%"]);
    expect(compareResults(run({ security: "off" }, { crud: scenario(1040, 9.7) }), baseline).failures).toEqual([]);
  });
});

const infrastructure = [
  { key: "security", enabledByDefault: true },
  { key: "tenancy", enabledByDefault: false },
  { key: "auth", enabledByDefault: false },
  { key: "metrics", enabledByDefault: false },
  { key: "proxy", enabledByDefault: false },
  { key: "secrets", enabledByDefault: false },
  { key: "realtime", enabledByDefault: false },
];
const onRun = (switches: Record<string, "on" | "off">, crud: ReturnType<typeof scenario>): BenchResult => ({
  features: { switches, defaults: Object.fromEntries(Object.keys(switches).map((key) => [key, "off"])) },
  scenarios: { crud },
});

describe("runner plans for the infrastructure switches", () => {
  test("tenancy=on serves the config tenant bench, migrates every tenant first and names it on every request", () => {
    const parsed = parseFeatures("tenancy=on", infrastructure);
    expect(parsed.variables).toEqual({ QS_TENANCY_ENABLED: "true", QS_TENANCY_SOURCE: "config", QS_TENANCY_TENANTS: '{"bench":{}}' });
    expect(parsed.plan).toEqual({ migrateAllTenants: true, headers: { "x-tenant-id": "bench" } });
    expect(parseFeatures("tenancy=off", infrastructure).plan).toEqual({ migrateAllTenants: false, headers: {} });
  });

  test("metrics, auth, proxy, secrets and realtime only set their variable", () => {
    const parsed = parseFeatures("metrics=on,auth=on", infrastructure);
    expect(parsed.variables).toEqual({ QS_AUTH_ENABLED: "true", QS_METRICS_ENABLED: "true" });
    expect(parsed.label).toBe("auth-on+metrics-on");
    expect(parsed.plan).toEqual({ migrateAllTenants: false, headers: {} });
    for (const key of ["proxy", "secrets", "realtime"]) expect(parseFeatures(`${key}=on`, infrastructure).variables).toEqual({ [`QS_${key.toUpperCase()}_ENABLED`]: "true" });
  });
});

describe("on-budget comparisons", () => {
  test("tenancy=on 8% slower on crud passes and 12% slower fails its 10% budget; metrics=on 4% slower fails its 3% budget", () => {
    expect(compareResults(onRun({ tenancy: "on" }, scenario(920, 10)), baseline).failures).toEqual([]);
    expect(compareResults(onRun({ tenancy: "on" }, scenario(880, 10)), baseline).failures).toEqual(["tenancy costs 12% on crud; the budget is 10%"]);
    expect(compareResults(onRun({ metrics: "on" }, scenario(960, 10)), baseline).failures).toEqual(["metrics costs 4% on crud; the budget is 3%"]);
  });

  test("metrics=on is held to 4% at p50: 3.5% higher passes and 4.5% higher fails", () => {
    expect(compareResults(onRun({ metrics: "on" }, scenario(1000, 10.35)), baseline).failures).toEqual([]);
    expect(compareResults(onRun({ metrics: "on" }, scenario(1000, 10.45)), baseline).failures).toEqual(["metrics costs 4.5% p50 on crud; the budget is 4%"]);
    expect(compareResults(onRun({ secrets: "on" }, scenario(1000, 10.4)), baseline).failures).toEqual(["secrets costs 4% on crud; the budget is 3%"]);
    for (const key of ["auth", "proxy", "secrets", "realtime"]) expect(compareResults(onRun({ [key]: "on" }, scenario(980, 10.2)), baseline).failures).toEqual([]);
  });
});

describe("the all-off comparison", () => {
  const allOff = Object.fromEntries(["tenancy", "auth", "metrics", "proxy", "secrets", "realtime"].map((key) => [key, "off" as const]));
  test("every infrastructure native off within 2% of the baseline passes, and 4% slower fails naming the metric", () => {
    expect(compareResults(onRun(allOff, scenario(985, 10.15)), baseline).failures).toEqual([]);
    expect(compareResults(onRun(allOff, scenario(960, 10)), baseline).failures).toEqual(["crud: throughput is 4.0% lower than the baseline; the noise budget is 3%"]);
    expect(compareResults(onRun(allOff, scenario(1000, 10.4)), baseline).failures).toEqual(["crud: p50 latency is 4.0% higher than the baseline; the noise budget is 3%"]);
  });
});
