import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const entry of readdirSync(join(root, "entities"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("live answers ok and ready reports the database check", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    expect(await (await service.fetch("/health/live")).json()).toEqual({ status: "ok" });
    const ready = await service.fetch("/health/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ok", checks: { database: { status: "ok", critical: true } } });
  } finally {
    await service.stop();
  }
});
