import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { MEMORY_IN_PRODUCTION, type ServiceConfig } from "./config.ts";
import "./index.ts";
import { startService } from "./service.ts";

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** Starts a service with `config`, returning the warnings it logged before it is stopped. */
async function warningsOf(config: ServiceConfig, env: Record<string, string | undefined>): Promise<string[]> {
  const warnings: string[] = [];
  const logger = { info() {}, error() {}, warn: (entry: Record<string, unknown>) => void warnings.push(String(entry.message)) };
  const target = { on: () => target, once: () => target, off: () => target, exit() {} };
  const running = await startService({
    projectConfig: { ...config, logger, server: { port: freePort() } },
    models: [],
    crudRoutes: [],
    endpoints: [],
    hooks: new Map(),
    env,
    process: target as never,
  });
  await running?.stop();
  return warnings;
}

test("a production service on the default memory database logs the warning once and starts", async () => {
  expect((await warningsOf({}, { NODE_ENV: "production" })).filter((warning) => warning === MEMORY_IN_PRODUCTION)).toHaveLength(1);
  expect(await warningsOf({ production: true }, {})).toContain(MEMORY_IN_PRODUCTION);
  expect(MEMORY_IN_PRODUCTION).toBe("quickservicets is using the in-memory database in production; every restart loses all data. Set database in quickservicets.config.ts.");
});

test("no warning outside production or on another database", async () => {
  expect(await warningsOf({}, {})).not.toContain(MEMORY_IN_PRODUCTION);
  const database = sqliteAdapter({ path: join(mkdtempSync(join(tmpdir(), "quickservicets-memory-default-")), "data.db") });
  expect(await warningsOf({ database }, { NODE_ENV: "production" })).not.toContain(MEMORY_IN_PRODUCTION);
});
