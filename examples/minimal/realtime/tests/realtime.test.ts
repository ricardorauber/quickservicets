import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const folder of ["endpoints", "entities"]) {
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

test("the clock stream sends the time as Server-Sent Events", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const response = await service.fetch("/clock");
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toMatch(/^data: \{"now":"\d{4}-\d\d-\d\dT[^"]+"\}\n\n/);
    await reader.cancel();
  } finally {
    await service.stop();
  }
});
