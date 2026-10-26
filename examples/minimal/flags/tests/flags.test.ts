import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints", "hooks", "jobs"]) {
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

test("GET /settings answers the caller's flags: checkout-v2 for u1 only", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    expect(await (await service.fetch("/settings", { headers: { "x-user-id": "u1" } })).json()).toEqual({ "checkout-v2": true, "dark-mode": true });
    expect(((await (await service.fetch("/settings")).json()) as Record<string, boolean>)["checkout-v2"]).toBe(false);
  } finally {
    await service.stop();
  }
});
