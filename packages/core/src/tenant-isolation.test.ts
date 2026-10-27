import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./index.ts";
import { entityModel, field } from "./entity-model.ts";
import { runTenantIsolationSuite } from "./testing/tenant-isolation.ts";

const postgres = process.env.TEST_POSTGRES_URL;
const mongodb = process.env.TEST_MONGODB_URL;

for (const strategy of ["schema", "database"] as const) {
  runTenantIsolationSuite({ adapter: "memory", strategy });
  runTenantIsolationSuite({ adapter: "sqlite", strategy });
  runTenantIsolationSuite({ adapter: "postgres", strategy, prefix: "qs-b08-iso", ...(postgres ? { url: postgres } : {}) });
  runTenantIsolationSuite({ adapter: "mongodb", strategy, prefix: "qs-b08-iso", ...(mongodb ? { url: mongodb } : {}) });
}

// A project's own entity gets the read and write checks too.
const invoice = entityModel("Invoice", { number: field({ type: "string", unique: true }), total: field({ type: "number" }) });
runTenantIsolationSuite({ adapter: "memory", strategy: "schema", name: "with Invoice", models: [invoice], entities: ["Invoice"] });

describe("the suite itself", () => {
  const runFile = (source: string, env: Record<string, string | undefined>) => {
    const dir = mkdtempSync(join(import.meta.dir, ".isolation-run-"));
    try {
      const file = join(dir, "suite.test.ts");
      writeFileSync(file, source);
      const report = join(dir, "report.xml");
      const result = Bun.spawnSync(["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`, file], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
      // The report names every test, skipped ones included.
      return `${result.stdout.toString()}${result.stderr.toString()}${readFileSync(report, "utf8")}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const header = `import "../index.ts";\nimport { runTenantIsolationSuite } from "../testing/tenant-isolation.ts";\n`;

  test("a resolver that keeps the first tenant's repositories fails the read check, naming the adapter and strategy", () => {
    const output = runFile(`${header}runTenantIsolationSuite({ adapter: "memory", strategy: "schema", brokenResolver: true });\n`, {});
    // The failing test is named with the adapter and the strategy of its run.
    expect(output).toMatch(/<testcase name="isolation: read beta&apos;s note as alpha" classname="reads &gt; tenant isolation: memory schema"[^>]*>\s*<failure/);
  }, 60_000);

  test("without TEST_POSTGRES_URL the run lists a named skipped test", () => {
    const output = runFile(`${header}runTenantIsolationSuite({ adapter: "postgres", strategy: "schema", url: process.env.TEST_POSTGRES_URL });\n`, { TEST_POSTGRES_URL: undefined });
    expect(output).toMatch(/<testcase name="tenant isolation: postgres \(set TEST_POSTGRES_URL to run\)"[^>]*>\s*<skipped/);
  }, 60_000);
});
