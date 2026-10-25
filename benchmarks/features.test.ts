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
    expect(resultFile("/r", "quickservice", parsed)).toBe(join("/r", "features", "events-on+security-off.json"));
  });

  test("unknown keys and malformed items stop the run", () => {
    expect(() => parseFeatures("nope=on", natives)).toThrow("Unknown feature nope; known: events, history, security");
    expect(() => parseFeatures("events", natives)).toThrow('Invalid --features item "events"');
  });

  test("without switches the result file is unchanged, and every QuickService run turns the rate limit off", () => {
    expect(resultFile("/r", "quickservice")).toBe(join("/r", "quickservice.json"));
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
