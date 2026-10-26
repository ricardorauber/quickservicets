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
    let entries;
    try {
      entries = readdirSync(join(root, folder), { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

test("an endpoint that throws answers 500 and its report reaches the memory reporter", async () => {
  const files = exampleFiles();
  files["quickservice.config.ts"] = files["quickservice.config.ts"]!.replace(
    'import { defineConfig, memoryAdapter } from "@quickservice/core";',
    'import { defineConfig, memoryAdapter } from "@quickservice/core";\nimport { memoryReporter } from "./reporters.ts";\nexport const reporter = memoryReporter();',
  ).replace("errors: {}", "errors: { reporter }");
  const service = await startTestService({ files });
  try {
    expect((await service.fetch("/boom")).status).toBe(500);
    const { reporter } = (await import(join(service.root, "quickservice.config.ts"))) as { reporter: { reports: ErrorReport[] } };
    expect(reporter.reports).toMatchObject([{ kind: "request", error: { message: "The payment provider timed out" }, request: { route: "/boom" } }]);
  } finally {
    await service.stop();
  }
});
