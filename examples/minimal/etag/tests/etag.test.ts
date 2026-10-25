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

test("a read has an ETag, and a conditional read with it answers 304", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const created = (await (await service.fetch("/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Plan", body: "v1" }) })).json()) as { id: string };
    const tag = (await service.fetch(`/documents/${created.id}`)).headers.get("etag")!;
    expect(tag).toMatch(/^".{22}"$/);
    expect((await service.fetch(`/documents/${created.id}`, { headers: { "if-none-match": tag } })).status).toBe(304);
  } finally {
    await service.stop();
  }
});
