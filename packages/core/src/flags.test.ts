import { describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { bucketOf, evaluateRule, type FlagRule } from "./features/flags/evaluate.ts";
import { configRules, flagEvaluator, requestFlags } from "./features/flags/index.ts";
import type { LogEntry } from "./logger.ts";
import type { ServiceRequest } from "./hooks.ts";

const resolve = (flags: unknown) => resolveConfig({ database: memoryAdapter(), flags } as ServiceConfig, {});
const rulesOf = (flags: unknown) => resolve(flags).features.find((feature) => feature.key === "flags")!.options.rules as Record<string, FlagRule>;

describe("options", () => {
  test("rules take true, false or who they are on for; names are checked", () => {
    expect(rulesOf({ rules: { "dark-mode": true, "old-search": false, "checkout-v2": { users: ["u1"] } } })).toEqual({
      "dark-mode": { enabled: true },
      "old-search": { enabled: false },
      "checkout-v2": { enabled: true, users: ["u1"] },
    });
    const flags = resolve({}).features.find((feature) => feature.key === "flags")!.options;
    expect([flags.source, flags.rules, flags.refresh]).toEqual(["config", {}, "30s"]);
    expect(() => resolve({ rules: { "Checkout V2": true } })).toThrow(
      'Invalid flags.rules.Checkout V2: a flag name starts with a lowercase letter and uses lowercase letters, digits, "_" and "-"',
    );
    expect(() => resolve({ rules: { percent: { percentage: 101 } } })).toThrow("flags.rules.percent.percentage");
  });
});

describe("evaluation", () => {
  test("disabled, user, tenant, percentage and default, in that order", () => {
    const rule = (fields: Partial<FlagRule>): FlagRule => ({ enabled: true, ...fields });
    expect(evaluateRule("f", rule({ enabled: false, users: ["u1"] }), { userId: "u1" })).toEqual({ on: false, reason: "disabled" });
    expect(evaluateRule("f", rule({ users: ["u1"] }), { userId: "u1" })).toEqual({ on: true, reason: "user" });
    expect(evaluateRule("f", rule({ tenants: ["acme"] }), { tenantId: "acme" })).toEqual({ on: true, reason: "tenant" });
    expect(evaluateRule("f", rule({ tenants: ["acme"] }), { tenantId: "globex" })).toEqual({ on: false, reason: "default" });
    expect(evaluateRule("f", rule({ percentage: 100 }), { userId: "x" })).toEqual({ on: true, reason: "percentage" });
    expect(evaluateRule("f", rule({}), {})).toEqual({ on: true, reason: "default" });
    expect(evaluateRule("f", rule({ users: ["u1"] }), { userId: "u2" })).toEqual({ on: false, reason: "default" });
  });

  test("percentage buckets are spread evenly, stable for an id, and skipped without a user and tenant", () => {
    const rule: FlagRule = { enabled: true, percentage: 30 };
    let on = 0;
    for (let index = 0; index < 10_000; index++) if (evaluateRule("rollout", rule, { userId: `user-${index}` }).on) on++;
    expect(on / 10_000).toBeGreaterThanOrEqual(0.28);
    expect(on / 10_000).toBeLessThanOrEqual(0.32);
    expect(bucketOf("rollout", { userId: "user-1" })).toBe(bucketOf("rollout", { userId: "user-1" }));
    expect(bucketOf("rollout", { tenantId: "acme" })).toBe(bucketOf("rollout", { userId: "acme" }));
    expect(evaluateRule("rollout", { enabled: true, percentage: 99 }, {})).toEqual({ on: false, reason: "default" });
  });
});

describe("the request evaluator", () => {
  test("memoizes each name for the request, lists every flag, and warns once per process about an unknown name", () => {
    const entries: LogEntry[] = [];
    const logger = { info: () => undefined, warn: (entry: LogEntry) => void entries.push(entry), error: () => undefined };
    let reads = 0;
    const rules = configRules({ "checkout-v2": { enabled: true, users: ["u1"] }, "dark-mode": { enabled: true } });
    const evaluator = flagEvaluator(() => (reads++, rules), logger);
    const req = { user: { id: "u1" }, tenant: undefined } as unknown as ServiceRequest;
    const flags = requestFlags(req, evaluator);
    reads = 0;
    expect([flags.on("checkout-v2"), flags.on("checkout-v2")]).toEqual([true, true]);
    expect(reads).toBe(1);
    expect(flags.all()).toEqual({ "checkout-v2": true, "dark-mode": true });
    expect([flags.on("nope"), flags.on("nope"), requestFlags(req, evaluator).on("nope"), flags.off("nope")]).toEqual([false, false, false, true]);
    expect(entries.filter((entry) => entry.message === "flags.unknown")).toEqual([expect.objectContaining({ flag: "nope" })]);
  });

  test("reads the request's user at the time of the call", () => {
    const evaluator = flagEvaluator(() => configRules({ beta: { enabled: true, users: ["u1"] } }), { info() {}, warn() {}, error() {} });
    const req = { user: undefined, tenant: undefined } as unknown as ServiceRequest & { user: unknown };
    const flags = requestFlags(req, evaluator);
    (req as { user: unknown }).user = { id: "u1" };
    expect(flags.on("beta")).toBe(true);
  });
});
