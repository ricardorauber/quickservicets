import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const dir of ["entities", "features"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

test("the service starts with security on by default and serves the API and the exempted probe", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    expect((await service.fetch("/posts")).status).toBe(200);
    expect(await (await service.fetch("/health/live")).json()).toEqual({ status: "ok" });
  } finally {
    await service.stop();
  }
});

test("security: false turns the whole feature off", async () => {
  const files = exampleFiles();
  files["quickservice.config.ts"] = files["quickservice.config.ts"]!.replace("probes: {},", "security: false,");
  delete files["features/probes/index.ts"];
  const service = await startTestService({ files });
  try {
    expect((await service.fetch("/posts")).status).toBe(200);
  } finally {
    await service.stop();
  }
});
