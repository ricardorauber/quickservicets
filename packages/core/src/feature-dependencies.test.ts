import { afterEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { ConfigError, resolveConfig } from "./config.ts";
import { defineFeature, logEnabledFeatures, registerNative, unregisterNative, type FeatureDefinition, type FeatureInput } from "./features.ts";
import type { LogEntry } from "./logger.ts";
import { integer, object } from "./options.ts";

const registered: string[] = [];
const native = (input: FeatureInput<never> & { options?: never }): FeatureDefinition => {
  const definition = registerNative(defineFeature({ docs: { summary: "Test native." }, ...input })) as FeatureDefinition;
  registered.push(definition.key);
  return definition;
};
const nativeWithLevel = (key: string, extra: Partial<FeatureInput<never>> = {}) => {
  const definition = registerNative(defineFeature({ docs: { summary: "Test native." }, key, options: object({ level: integer().default(1) }), ...extra }));
  registered.push(key);
  return definition;
};
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
});

// The default security native is off, so the feature lists hold only the test natives.
const resolve = (config: Record<string, unknown>) => resolveConfig({ database: memoryAdapter(), security: false, ...config }, {});
const failure = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const keys = (config: Record<string, unknown>) => resolve(config).features.map((feature) => feature.key);

describe("requirement forms", () => {
  test("requires, after and enables take feature keys; requires entries may carry a hint", () => {
    const definition = defineFeature({ docs: { summary: "Test native." }, key: "trail", requires: ["signals", { name: "tasks", hint: "deliveries run on tasks" }], after: ["cache"], enables: ["audit"] });
    expect(definition.requires).toEqual([{ name: "signals" }, { name: "tasks", hint: "deliveries run on tasks" }]);
    expect(definition.after).toEqual(["cache"]);
    expect(definition.enables).toEqual(["audit"]);
    expect(Object.isFrozen(definition.requires)).toBe(true);
    expect(defineFeature({ docs: { summary: "Test native." }, key: "plain" })).toMatchObject({ requires: [], after: [], enables: [] });
  });

  test("invalid entries make defineFeature throw", () => {
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "x", requires: ["Events"] })).message).toBe('Invalid feature x: requires has an invalid key "Events"');
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "x", requires: [{ name: "" }] })).message).toStartWith("Invalid feature x: requires has an invalid key");
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "x", after: ["a b"] })).message).toBe('Invalid feature x: after has an invalid key "a b"');
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "x", enables: [3 as never] })).message).toBe("Invalid feature x: enables has an invalid key 3");
  });
});

describe("missing requirements", () => {
  test("a required native that is not enabled fails with how to fix it", () => {
    native({ key: "signals" });
    native({ key: "trail", requires: ["signals"] });
    const error = failure(() => resolve({ trail: {} }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe("trail requires signals; add signals: {} to quickservice.config.ts");
    expect(keys({ trail: {}, signals: {} })).toEqual(["signals", "trail"]);
  });

  test("every missing requirement is one line of one error, with its hint", () => {
    native({ key: "signals" });
    native({ key: "tasks" });
    native({ key: "trail", requires: ["signals", { name: "tasks", hint: "deliveries run on tasks" }] });
    expect(failure(() => resolve({ trail: {} })).message.split("\n")).toEqual([
      "trail requires signals; add signals: {} to quickservice.config.ts",
      "trail requires tasks; add tasks: {} to quickservice.config.ts (deliveries run on tasks)",
    ]);
  });

  test("a requirement that no feature registers is named as such", () => {
    native({ key: "trail", requires: ["nope"] });
    expect(failure(() => resolve({ trail: {} })).message).toBe("trail requires nope, which is not a native feature");
  });

  test("a disabled feature requires nothing", () => {
    native({ key: "trail", requires: ["nope"] });
    expect(keys({})).toEqual([]);
    expect(keys({ trail: { enabled: false } })).toEqual([]);
  });
});

describe("enables", () => {
  test("a listed native without a key is enabled with its defaults and recorded in enabledBy", () => {
    nativeWithLevel("audit");
    native({ key: "trail", enables: ["audit"] });
    const resolved = resolve({ trail: {} });
    expect(resolved.features.map(({ key, options }) => [key, options])).toEqual([
      ["audit", { level: 1, enabled: true }],
      ["trail", { enabled: true }],
    ]);
    expect(resolved.enabledBy).toEqual({ audit: ["trail"] });
    expect(resolve({}).enabledBy).toEqual({});
  });

  test("the project's own options apply unchanged", () => {
    nativeWithLevel("audit");
    native({ key: "trail", enables: ["audit"] });
    const resolved = resolve({ trail: {}, audit: { level: 3 } });
    expect(resolved.features.find((feature) => feature.key === "audit")!.options).toEqual({ level: 3, enabled: true });
    expect(resolved.enabledBy).toEqual({});
    expect(resolve({ trail: {}, audit: true }).features.map((feature) => feature.key)).toEqual(["audit", "trail"]);
  });

  test("a listed native set to false fails, and so does enabled: false", () => {
    nativeWithLevel("audit");
    native({ key: "trail", enables: ["audit"] });
    const message = "trail needs audit, but audit is false; remove audit: false or turn off trail";
    expect(failure(() => resolve({ trail: {}, audit: false })).message).toBe(message);
    expect(failure(() => resolve({ trail: {}, audit: { enabled: false } })).message).toBe(message);
  });

  test("a disabled feature enables nothing; enabled natives enable others in turn", () => {
    nativeWithLevel("audit");
    native({ key: "store", enables: ["audit"] });
    native({ key: "trail", enables: ["store"] });
    expect(keys({ trail: false })).toEqual([]);
    expect(keys({ trail: { enabled: false }, audit: false })).toEqual([]);
    const resolved = resolve({ trail: {} });
    expect(resolved.features.map((feature) => feature.key)).toEqual(["audit", "store", "trail"]);
    expect(resolved.enabledBy).toEqual({ store: ["trail"], audit: ["store"] });
  });

  test("several features enabling one native are all recorded", () => {
    nativeWithLevel("audit");
    native({ key: "one", enables: ["audit"] });
    native({ key: "two", enables: ["audit"] });
    expect(resolve({ one: {}, two: {} }).enabledBy).toEqual({ audit: ["one", "two"] });
  });
});

describe("order", () => {
  test("a feature comes after the natives it requires, keeping registration order otherwise", () => {
    native({ key: "trail", requires: ["signals"] });
    native({ key: "signals" });
    native({ key: "other" });
    expect(keys({ trail: {}, signals: {}, other: {} })).toEqual(["signals", "trail", "other"]);
  });

  test("after entries order only when they are enabled", () => {
    native({ key: "search", after: ["tasks"] });
    native({ key: "tasks" });
    expect(keys({ search: {}, tasks: {} })).toEqual(["tasks", "search"]);
    expect(keys({ search: {} })).toEqual(["search"]);
  });

  test("a cycle fails naming its path", () => {
    native({ key: "a", requires: ["b"] });
    native({ key: "b", after: ["a"] });
    expect(failure(() => resolve({ a: {}, b: {} })).message).toBe("Feature dependency cycle: a -> b -> a");
    native({ key: "c", enables: ["d"] });
    native({ key: "d", requires: ["e"] });
    native({ key: "e", requires: ["c"] });
    expect(failure(() => resolve({ c: {}, e: {} })).message).toBe("Feature dependency cycle: c -> d -> e -> c");
  });
});

describe("startup log", () => {
  test("one features.enabled entry lists the ordered keys and who enabled each native", () => {
    nativeWithLevel("audit");
    native({ key: "signals" });
    native({ key: "trail", requires: ["signals"], enables: ["audit"] });
    const entries: LogEntry[] = [];
    const logger = { info: (entry: LogEntry) => entries.push(entry), warn() {}, error() {} };
    const config = resolveConfig({ database: memoryAdapter(), logger, security: false, trail: {}, signals: {} } as never, {});
    logEnabledFeatures(config);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ message: "features.enabled", features: [{ key: "audit", enabledBy: ["trail"] }, { key: "signals" }, { key: "trail" }] });
    expect(typeof entries[0]!.timestamp).toBe("string");
  });
});
