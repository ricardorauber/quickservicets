import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAdapter } from "./adapters/memory.ts";
import { ConfigError, defineConfig, loadConfig, resolveConfig, type ServiceConfig } from "./config.ts";

const coreEntry = join(import.meta.dir, "index.ts");

function projectWithConfig(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "quickservice-config-"));
  writeFileSync(
    join(root, "quickservice.config.ts"),
    `import { defineConfig, memoryAdapter } from ${JSON.stringify(coreEntry)};\nexport default ${body};\n`,
  );
  return root;
}

test("defineConfig returns the same object", () => {
  const config: ServiceConfig = { database: memoryAdapter() };
  expect(defineConfig(config)).toBe(config);
});

describe("defaults", () => {
  test("port and production flag", () => {
    const resolved = resolveConfig({ database: memoryAdapter() }, {});
    expect(resolved.server.port).toBe(3000);
    expect(resolved.production).toBe(false);
  });
  test("explicit values win", () => {
    const resolved = resolveConfig({ database: memoryAdapter(), server: { port: 4000 }, production: true }, { PORT: "5000" });
    expect(resolved).toMatchObject({ server: { port: 4000 }, production: true });
  });
});

describe("environment fallbacks", () => {
  test("PORT", () => {
    expect(resolveConfig({ database: memoryAdapter() }, { PORT: "8080" }).server.port).toBe(8080);
  });
  test("NODE_ENV", () => {
    expect(resolveConfig({ database: memoryAdapter() }, { NODE_ENV: "production" }).production).toBe(true);
    expect(resolveConfig({ database: memoryAdapter() }, { NODE_ENV: "development" }).production).toBe(false);
  });
});

test("a missing file names the expected path", async () => {
  const root = mkdtempSync(join(tmpdir(), "quickservice-config-"));
  await expect(loadConfig(root)).rejects.toThrow("quickservice.config.ts");
});

test.each([0, 70000, 3.5])("port %p is rejected naming server.port", (port) => {
  expect(() => resolveConfig({ database: memoryAdapter(), server: { port } }, {})).toThrow("server.port");
});

test("a missing database is rejected", () => {
  expect(() => resolveConfig({} as ServiceConfig, {})).toThrow(ConfigError);
  expect(() => resolveConfig({} as ServiceConfig, {})).toThrow("database");
});

test("loadConfig imports the default export and applies defaults", async () => {
  const root = projectWithConfig("defineConfig({ database: memoryAdapter(), server: { port: 4321 } })");
  const config = await loadConfig(root, {});
  expect(config.server.port).toBe(4321);
  expect(config.production).toBe(false);
  expect(typeof config.database.insert).toBe("function");
});
