import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAdapter } from "./adapters/memory.ts";
import { ConfigError, defineConfig, loadConfig, resolveConfig, type ServiceConfig } from "./config.ts";
import { jobSettings } from "./jobs/job.ts";

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

describe("jobs", () => {
  const resolveJobs = (jobs: unknown, env: Record<string, string | undefined> = {}) =>
    resolveConfig({ database: memoryAdapter(), jobs } as ServiceConfig, env).jobs;

  test("defaults without a jobs key", () => {
    expect(resolveConfig({ database: memoryAdapter() }, {}).jobs).toEqual({
      enabled: true,
      timeZone: "UTC",
      timeout: "5m",
      retries: 0,
      retryDelay: "30s",
      retention: "30d",
      shutdownGrace: "10s",
      limits: { result: "64KB", logLines: 500 },
    });
  });

  test("explicit values win, and partial limits keep the other default", () => {
    const jobs = resolveJobs({ enabled: false, timeZone: "America/Sao_Paulo", timeout: "1h", retries: 3, retryDelay: "1m", retention: "7d", shutdownGrace: "30s", limits: { logLines: 50 } });
    expect(jobs).toEqual({
      enabled: false,
      timeZone: "America/Sao_Paulo",
      timeout: "1h",
      retries: 3,
      retryDelay: "1m",
      retention: "7d",
      shutdownGrace: "30s",
      limits: { result: "64KB", logLines: 50 },
    });
    expect(resolveJobs({ limits: { result: 1024 } }).limits).toEqual({ result: 1024, logLines: 500 });
  });

  test("JOBS_ENABLED overrides enabled", () => {
    expect(resolveJobs(undefined, { JOBS_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveJobs({ enabled: true }, { JOBS_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveJobs({ enabled: false }, { JOBS_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveJobs({ enabled: false }, { JOBS_ENABLED: "" }).enabled).toBe(false);
    expect(() => resolveJobs(undefined, { JOBS_ENABLED: "maybe" })).toThrow("Invalid JOBS_ENABLED");
  });

  test.each([
    ["timeout", { timeout: "soon" }],
    ["retryDelay", { retryDelay: 30 }],
    ["retention", { retention: "30 days" }],
    ["shutdownGrace", { shutdownGrace: "10ms" }],
    ["timeZone", { timeZone: "Mars/Base" }],
    ["retries", { retries: -1 }],
    ["retries", { retries: 1.5 }],
    ["enabled", { enabled: "yes" }],
    ["limits.result", { limits: { result: "lots" } }],
    ["limits.logLines", { limits: { logLines: 0 } }],
  ])("an invalid %s is rejected naming the key", (key, jobs) => {
    expect(() => resolveJobs(jobs)).toThrow(ConfigError);
    expect(() => resolveJobs(jobs)).toThrow(`Invalid jobs.${key}:`);
  });

  test("job options override the defaults per job", () => {
    const defaults = resolveConfig({ database: memoryAdapter(), jobs: { retries: 2, timeZone: "Europe/Lisbon" } }, {}).jobs;
    expect(jobSettings({}, defaults)).toEqual({ retries: 2, retryDelay: "30s", timeout: "5m", retention: "30d", timeZone: "Europe/Lisbon", overlap: "skip" });
    expect(jobSettings({ retries: 0, timeout: "1s", retention: "7d", retryDelay: "1s", timeZone: "UTC", overlap: "parallel" }, defaults)).toEqual({
      retries: 0,
      retryDelay: "1s",
      timeout: "1s",
      retention: "7d",
      timeZone: "UTC",
      overlap: "parallel",
    });
  });

  test("loadConfig throws naming jobs.timeout", async () => {
    const root = projectWithConfig('defineConfig({ database: memoryAdapter(), jobs: { timeout: "soon" } })');
    await expect(loadConfig(root, {})).rejects.toThrow('Invalid jobs.timeout: expected a duration like 30s, 10m or 30d, got "soon"');
  });
});
