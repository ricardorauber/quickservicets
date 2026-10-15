import { describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig } from "./config.ts";

const resolve = (schema: string | undefined, env: Record<string, string | undefined>) =>
  resolveConfig({ database: memoryAdapter(), ...(schema === undefined ? {} : { schema }) }, env).schema;

describe("precedence", () => {
  test("DATABASE_SCHEMA wins over the config", () => {
    expect(resolve("app", { DATABASE_SCHEMA: "tenant-a" })).toBe("tenant-a");
  });
  test("the config is used without the variable", () => {
    expect(resolve("app", {})).toBe("app");
  });
  test("null without either", () => {
    expect(resolve(undefined, {})).toBeNull();
  });
});

describe("validation", () => {
  test("an invalid DATABASE_SCHEMA is named", () => {
    expect(() => resolve(undefined, { DATABASE_SCHEMA: "Bad" })).toThrow("DATABASE_SCHEMA");
  });
  test("an invalid config schema is named", () => {
    expect(() => resolve("Bad", {})).toThrow("schema");
  });
});
