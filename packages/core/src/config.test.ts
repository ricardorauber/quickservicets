import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { ConfigError, defineConfig, loadConfig, resolveConfig, type ServiceConfig } from "./config.ts";
import { jobSettings } from "./jobs/job.ts";
import { availableCpus } from "./workers.ts";

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

describe("server.workers", () => {
  const postgres = postgresAdapter({ url: "postgres://localhost/none" });
  const twoCpus = () => 2;
  const production = { NODE_ENV: "production" };

  test("every CPU by default in production on Linux with a database server, 1 otherwise", () => {
    const mongodb = mongodbAdapter({ url: "mongodb://localhost/none", database: "none" });
    expect(resolveConfig({ database: postgres }, production, undefined, twoCpus, "linux").server.workers).toBe(2);
    expect(resolveConfig({ database: mongodb }, production, undefined, twoCpus, "linux").server.workers).toBe(2);
    expect(resolveConfig({ database: postgres, production: true }, {}, undefined, twoCpus, "linux").server.workers).toBe(2);
    expect(resolveConfig({ database: postgres }, {}, undefined, twoCpus, "linux").server.workers).toBe(1);
    expect(resolveConfig({ database: postgres }, production, undefined, twoCpus, "darwin").server.workers).toBe(1);
    expect(resolveConfig({ database: postgres, production: false }, production, undefined, twoCpus, "linux").server.workers).toBe(1);
    expect(resolveConfig({ database: memoryAdapter() }, production, undefined, twoCpus, "linux").server.workers).toBe(1);
    expect(resolveConfig({ database: sqliteAdapter({ path: ":memory:" }) }, production, undefined, twoCpus, "linux").server.workers).toBe(1);
  });

  test("an explicit value wins over the production default", () => {
    expect(resolveConfig({ database: postgres, server: { workers: 1 } }, production, undefined, twoCpus, "linux").server.workers).toBe(1);
    expect(resolveConfig({ database: postgres }, { ...production, QS_WORKERS: "1" }, undefined, twoCpus, "linux").server.workers).toBe(1);
    expect(resolveConfig({ database: postgres }, { ...production, QS_WORKERS: "" }, undefined, twoCpus, "linux").server.workers).toBe(2);
  });

  test("an integer or auto, 1 by default, and QS_WORKERS overrides the config", async () => {
    expect(resolveConfig({ database: postgres }, {}).server.workers).toBe(1);
    expect(resolveConfig({ database: postgres, server: { workers: 4 } }, {}).server.workers).toBe(4);
    expect(resolveConfig({ database: postgres, server: { workers: "auto" } }, {}, undefined, twoCpus).server.workers).toBe(2);
    expect(resolveConfig({ database: postgres, server: { workers: 4 } }, { QS_WORKERS: "3" }).server.workers).toBe(3);
    expect(resolveConfig({ database: postgres }, { QS_WORKERS: "auto" }, undefined, twoCpus).server.workers).toBe(2);
    expect(resolveConfig({ database: postgres, server: { workers: 3 } }, { QS_WORKERS: "" }).server.workers).toBe(3);
    for (const workers of [0, -1, 1.5, "x", "2"]) {
      expect(() => resolveConfig({ database: postgres, server: { workers: workers as never } }, {})).toThrow(
        `Invalid server.workers: expected a positive integer or "auto", got ${JSON.stringify(workers)}`,
      );
    }
    expect(() => resolveConfig({ database: postgres }, { QS_WORKERS: "0" })).toThrow('Invalid QS_WORKERS (server.workers): expected a positive integer or "auto", got "0"');
    await expect(loadConfig(projectWithConfig('defineConfig({ database: memoryAdapter(), server: { workers: "x" } })'), {})).rejects.toThrow("Invalid server.workers");
    // "auto" reads the container's CPU quota, then the host's CPUs.
    const host = () => 8;
    expect(availableCpus(() => "200000 100000\n", host)).toBe(2);
    expect(availableCpus(() => "150000 100000", host)).toBe(2);
    expect(availableCpus(() => "50000 100000", host)).toBe(1);
    expect(availableCpus(() => "1600000 100000", host)).toBe(8);
    expect(availableCpus(() => "max 100000", host)).toBe(8);
    expect(availableCpus(() => undefined, host)).toBe(8);
    expect(availableCpus(() => "garbage", host)).toBe(8);
    expect(availableCpus()).toBeGreaterThanOrEqual(1);
  });

  test("more than one worker needs a database server", async () => {
    const message = "server.workers > 1 requires a database server (PostgreSQL or MongoDB)";
    expect(() => resolveConfig({ database: memoryAdapter(), server: { workers: 2 } }, {})).toThrow(message);
    expect(() => resolveConfig({ database: sqliteAdapter({ path: ":memory:" }) }, { QS_WORKERS: "2" })).toThrow(message);
    expect(() => resolveConfig({ database: memoryAdapter() }, { QS_WORKERS: "auto" }, undefined, twoCpus)).toThrow(message);
    expect(resolveConfig({ database: sqliteAdapter({ path: ":memory:" }), server: { workers: 1 } }, {}).server.workers).toBe(1);
    expect(resolveConfig({ database: mongodbAdapter({ url: "mongodb://localhost/none", database: "none" }), server: { workers: 2 } }, {}).server.workers).toBe(2);
    await expect(loadConfig(projectWithConfig("defineConfig({ database: memoryAdapter(), server: { workers: 2 } })"), {})).rejects.toThrow(message);
  });
});
