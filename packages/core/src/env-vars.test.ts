import { afterEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { ConfigError, resolveConfig, type ServiceConfig } from "./config.ts";
import { clearEnvValues, declaredVariables, env } from "./env-vars.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { boolean, integer, list, oneOf, secret, string, url } from "./options.ts";

const declaration = { DATABASE_URL: url().protocols(["postgres"]), STRIPE_KEY: secret(), REPORT_HOUR: integer().min(0).max(23).default(6) };
const resolve = (variables: Record<string, string>, config: Record<string, unknown> = {}) =>
  resolveConfig({ database: memoryAdapter(), env: declaration, security: false, http: false, ...config } as ServiceConfig, variables);
const failure = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
/** The variables without the generated `EnvVars` types, which this package does not have. */
const vars = env as unknown as Record<string, any>;
const values = { DATABASE_URL: "postgres://localhost/app", STRIPE_KEY: "sk_test_1" };

afterEach(() => unregisterNative("example"));

describe("declarations", () => {
  test("names are upper snake case and never QS_", () => {
    expect(failure(() => resolve({}, { env: { "bad-name": string() } })).message).toBe("Invalid environment variable name bad-name declared by the project: use ^[A-Z][A-Z0-9_]*$");
    expect(failure(() => resolve({}, { env: { QS_X: string() } })).message).toBe("Invalid environment variable name QS_X declared by the project: QS_ names are reserved for config overrides");
    expect(failure(() => resolve({}, { env: { NAME: "text" } })).message).toContain("expected an option schema");
  });

  test("feature variables merge with the project's; different kinds fail", () => {
    const example = defineFeature({ docs: { summary: "Test native." }, key: "example", env: { EXAMPLE_API_URL: url().optional(), SHARED: string().describe("From the feature.").default("feature") } });
    registerNative(example);
    expect(resolve(values, { example: {} }).features).toHaveLength(1);
    expect(vars.EXAMPLE_API_URL).toBeUndefined();
    expect(resolve({ ...values, EXAMPLE_API_URL: "https://api.example.com" }, { example: {} }).features).toHaveLength(1);
    expect(vars.EXAMPLE_API_URL).toBe("https://api.example.com");
    expect(failure(() => resolve(values, { example: {}, env: { ...declaration, EXAMPLE_API_URL: integer() } })).message).toBe(
      "EXAMPLE_API_URL is declared as integer by the project and as url by example",
    );
  });

  test("with the same kind, the project's description and default win", () => {
    const merged = declaredVariables({ SHARED: string().default("project") }, [{ key: "example", env: { SHARED: string().describe("From the feature.").default("feature") } }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.owner).toBe("the project");
    expect(merged[0]!.schema.settings).toMatchObject({ default: "project", description: "From the feature." });
    const described = declaredVariables({ SHARED: string().describe("From the project.") }, [{ key: "example", env: { SHARED: string().describe("From the feature.").default("feature") } }]);
    expect(described[0]!.schema.settings).toMatchObject({ description: "From the project.", default: "feature" });
  });

  test("a disabled feature declares nothing", () => {
    registerNative(defineFeature({ docs: { summary: "Test native." }, key: "example", env: { EXAMPLE_TOKEN: secret() } }));
    expect(() => resolve(values)).not.toThrow();
    expect(failure(() => resolve(values, { example: {} })).message).toContain("EXAMPLE_TOKEN is required (secret)");
  });
});

describe("reading", () => {
  test("variables are parsed, with defaults", () => {
    resolve({ ...values, REPORT_HOUR: "" });
    expect(vars.REPORT_HOUR).toBe(6);
    resolve({ ...values, REPORT_HOUR: "7" });
    expect(vars.REPORT_HOUR + 1).toBe(8);
    resolve({ FLAGS: "a, b", DEBUG: "TRUE", MODE: "fast" }, { env: { FLAGS: list(string()), DEBUG: boolean(), MODE: oneOf(["fast", "safe"]) } });
    expect({ ...vars }).toEqual({ FLAGS: ["a", "b"], DEBUG: true, MODE: "fast" });
  });

  test("every missing or invalid variable is listed in one error", () => {
    const error = failure(() => resolve({ REPORT_HOUR: "25" }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message.split("\n")).toEqual([
      "Invalid environment:",
      "  DATABASE_URL is required (url)",
      "  STRIPE_KEY is required (secret)",
      '  REPORT_HOUR: expected an integer of at most 23, got "25"',
    ]);
    expect(failure(() => resolve({ ...values, DATABASE_URL: "https://x" })).message).toContain('DATABASE_URL: expected an absolute URL with protocol postgres, got "https://x"');
  });

  test("secret values never appear in the error", () => {
    const message = failure(() => resolve({ ...values, STRIPE_KEY: "sk_live_123" }, { env: { ...declaration, STRIPE_KEY: secret().min(40) } })).message;
    expect(message).toContain("STRIPE_KEY: expected a string of at least 40 characters, got [secret]");
    expect(message).not.toContain("sk_live_123");
  });
});

describe("the env object", () => {
  test("reading it before a configuration is resolved throws", () => {
    clearEnvValues();
    expect(() => vars.DATABASE_URL).toThrow("env.DATABASE_URL was read before the configuration was resolved; use process.env inside quickservicets.config.ts");
  });

  test("after resolution it holds the parsed values and is read-only", () => {
    resolve(values);
    expect(vars.DATABASE_URL).toBe("postgres://localhost/app");
    expect(Object.keys(vars)).toEqual(["DATABASE_URL", "STRIPE_KEY", "REPORT_HOUR"]);
    expect(() => {
      vars.DATABASE_URL = "x";
    }).toThrow();
    expect(vars.DATABASE_URL).toBe("postgres://localhost/app");
  });

  test("a failed resolution keeps the values of the last one that resolved", () => {
    resolve(values);
    failure(() => resolve({}));
    expect(vars.STRIPE_KEY).toBe("sk_test_1");
  });

  test("a configuration without env resolves as before, with no variables", () => {
    resolveConfig({ database: memoryAdapter() }, {});
    expect(Object.keys(vars)).toEqual([]);
  });
});
