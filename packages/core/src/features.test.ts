import { afterEach, describe, expect, test } from "bun:test";
// The natives the core ships register when the core loads; these tests count them among the disabled features.
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { ConfigError, resolveConfig, type ServiceConfig } from "./config.ts";
import { defineFeature, registeredNatives, registerNative, unregisterNative, type FeatureConfig } from "./features.ts";
import { duration, integer, object, string } from "./options.ts";

const audit = defineFeature({
  key: "audit",
  options: object({ level: integer().default(1), target: string().optional() }),
  docs: { summary: "Records who changed what." },
});
const stamps = defineFeature({ docs: { summary: "Test native." }, key: "stamps", options: object({ retention: duration().default("30d") }), enabledByDefault: true });

declare module "./features.ts" {
  interface NativeFeatures {
    audit?: FeatureConfig<typeof audit>;
    stamps?: FeatureConfig<typeof stamps>;
  }
}

const registered: string[] = [];
const register = (...definitions: Parameters<typeof registerNative>[0][]) => {
  for (const definition of definitions) {
    registerNative(definition);
    registered.push(definition.key);
  }
};
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
});

// The default security native is off, so the feature lists hold only the test natives.
const resolve = (config: Partial<ServiceConfig>) => resolveConfig({ database: memoryAdapter(), security: false, ...config }, {});
const failure = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("definitions", () => {
  test("a definition carries its key, docs and options schema with the implicit enabled option", () => {
    expect(audit.key).toBe("audit");
    expect(audit.docs).toEqual({ summary: "Records who changed what." });
    expect(audit.enabledByDefault).toBe(false);
    expect(Object.keys(audit.schema.settings.shape!)).toEqual(["level", "target", "enabled"]);
    expect(defineFeature({ docs: { summary: "Test native." }, key: "plain" }).schema.settings.shape).toHaveProperty("enabled");
  });

  test("definitions are immutable", () => {
    expect(Object.isFrozen(audit)).toBe(true);
    expect(() => {
      (audit as { key: string }).key = "other";
    }).toThrow();
  });

  test("invalid keys and options are refused", () => {
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "Bad Key" })).message).toBe("Invalid feature Bad Key: the key must match ^[a-z][a-z0-9-]*$");
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "1st" })).message).toStartWith("Invalid feature 1st:");
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "x", options: string() as never })).message).toBe("Invalid feature x: options must be an object({...}) schema");
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "x", options: object({ enabled: string() }) })).message).toBe(
      "Invalid feature x: enabled is an implicit option and cannot be declared",
    );
  });

  test("built-in config keys are reserved", () => {
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "jobs" })).message).toBe("Invalid feature jobs: jobs is a built-in config key");
    expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key: "server" })).message).toBe("Invalid feature server: server is a built-in config key");
    for (const key of ["database", "env", "plugins", "middleware", "lifecycle", "features"]) {
      expect(failure(() => defineFeature({ docs: { summary: "Test native." }, key })).message).toContain(`${key} is a built-in config key`);
    }
  });
});

describe("enabling natives", () => {
  test("a key set to an object or true enables the native; false or no key disables it", () => {
    register(audit);
    expect(resolve({ audit: {} }).features.map((feature) => [feature.key, feature.options, feature.native])).toEqual([["audit", { level: 1, enabled: true }, true]]);
    expect(resolve({ audit: true }).features[0]!.options).toEqual({ level: 1, enabled: true });
    for (const config of [{ audit: false }, {}]) {
      const resolved = resolve(config);
      expect(resolved.features).toEqual([]);
      expect(resolved.disabledFeatures).toEqual(["security", "events", "queues", "health", "idempotency", "etag", "history", "realtime", "errors", "flags", "audit"]);
    }
  });

  test("enabledByDefault natives are on without a key and off with false or enabled: false", () => {
    register(stamps);
    expect(resolve({}).features.map((feature) => feature.key)).toEqual(["stamps"]);
    expect(resolve({ stamps: false }).features).toEqual([]);
    expect(resolve({ stamps: { enabled: false } }).features).toEqual([]);
    expect(resolve({ stamps: { enabled: false } }).disabledFeatures).toEqual(["security", "events", "queues", "health", "idempotency", "etag", "history", "realtime", "errors", "flags", "stamps"]);
  });

  test("the implicit enabled option turns a configured native off", () => {
    register(audit);
    expect(resolve({ audit: { enabled: false, level: 2 } }).features).toEqual([]);
    expect(resolve({ audit: { enabled: true } }).features).toHaveLength(1);
  });

  test("registering a key twice throws", () => {
    register(audit);
    expect(failure(() => registerNative(audit)).message).toBe("Native audit is registered twice");
    expect(registeredNatives().map((definition) => definition.key)).toContain("audit");
  });
});

describe("option resolution", () => {
  test("options resolve under the key, and the lists name every feature", () => {
    register(audit, stamps);
    const resolved = resolve({ audit: { level: 3, target: "db" } });
    expect(resolved.features.map(({ key, options }) => ({ key, options }))).toEqual([
      { key: "audit", options: { level: 3, target: "db", enabled: true } },
      { key: "stamps", options: { retention: "30d", enabled: true } },
    ]);
    expect(resolved.features[0]!.definition).toBe(audit);
    // The registered natives that are off, like events, are listed too.
    expect(resolved.disabledFeatures).toEqual(["security", "events", "queues", "health", "idempotency", "etag", "history", "realtime", "errors", "flags"]);
  });

  test("invalid options name the key's path, for every feature at once", () => {
    register(audit, stamps);
    const error = failure(() => resolve({ audit: { level: "x" as never }, stamps: { retention: "soon" } }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message.split("\n")[0]).toBe('Invalid audit.level: expected an integer, got "x"');
    expect(error.message.split("\n")[1]).toStartWith("Invalid stamps.retention: expected a duration");
    expect(failure(() => resolve({ audit: { levle: 1 } as never })).message).toBe("Unknown option audit.levle (did you mean level?)");
    expect(failure(() => resolve({ audit: "yes" as never })).message).toBe('Invalid audit: expected an options object, true or false, got "yes"');
  });

  test("a configuration without features resolves as before", () => {
    const resolved = resolve({});
    expect(resolved.features).toEqual([]);
    expect(resolved.disabledFeatures).toEqual(["security", "events", "queues", "health", "idempotency", "etag", "history", "realtime", "errors", "flags"]);
  });
});

describe("options()", () => {
  test("reads the resolved options once a configuration enabling the feature is resolved", () => {
    register(audit);
    const local = defineFeature({ docs: { summary: "Test native." }, key: "local", options: object({ level: integer().default(0) }) });
    expect(failure(() => local.options()).message).toBe("local is not enabled; add local: {} to quickservicets.config.ts");
    resolve({ audit: { level: 2 } });
    const level: number = audit.options().level;
    expect(level).toBe(2);
    expect(audit.options().enabled).toBe(true);
    resolve({ audit: false });
    expect(failure(() => audit.options()).message).toBe("audit is not enabled; add audit: {} to quickservicets.config.ts");
  });
});

// Type-level checks: this function is compiled by tsc but never called.
function typed() {
  const ok: ServiceConfig = { database: memoryAdapter(), audit: { level: 3 } };
  const on: ServiceConfig = { database: memoryAdapter(), audit: true };
  // @ts-expect-error level is an integer option
  const wrongType: ServiceConfig = { database: memoryAdapter(), audit: { level: "3" } };
  // @ts-expect-error the schema declares no such option
  const unknown: ServiceConfig = { database: memoryAdapter(), audit: { colour: "red" } };
  // @ts-expect-error a target is a string
  const target: string = audit.options().level;
  return [ok, on, wrongType, unknown, target];
}

test("feature config keys and options are typed", () => {
  expect(typed).toBeDefined();
});
