import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";
import type { ErrorReport } from "@quickservice/core";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of ["quickservice.config.ts", "reporters.ts"]) files[file] = readFileSync(join(root, file), "utf8");
  for (const folder of ["endpoints", "jobs"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

test("the throwing endpoint and the failing job reach the memory reporter; the response stays a 500", async () => {
  const files = exampleFiles();
  files["quickservice.config.ts"] = files["quickservice.config.ts"]!.replace(
    'import { defineConfig, memoryAdapter } from "@quickservice/core";',
    'import { defineConfig, memoryAdapter } from "@quickservice/core";\nimport { memoryReporter } from "./reporters.ts";\nexport const reporter = memoryReporter();',
  ).replace("errors: {}", 'errors: { reporter, release: "1.0.0" }');
  const service = await startTestService({ files });
  try {
    expect((await service.fetch("/boom")).status).toBe(500);
    await service.fetch("/sync", { method: "POST" });
    const { reporter } = (await import(join(service.root, "quickservice.config.ts"))) as { reporter: { reports: ErrorReport[] } };
    for (let tries = 0; tries < 200 && reporter.reports.length < 2; tries++) await Bun.sleep(10);
    expect(reporter.reports.map((report) => [report.kind, report.error.message, report.release])).toEqual([
      ["request", "The payment provider timed out", "1.0.0"],
      ["job", "The invoice provider refused the connection", "1.0.0"],
    ]);
    expect(reporter.reports[1]!.job!.name).toBe("sync-invoices");
  } finally {
    await service.stop();
  }
});
