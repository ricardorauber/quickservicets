import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("the project serves its posts", async () => {
  const service = await startTestService({ files: { "quickservicets.config.ts": read("quickservicets.config.ts"), "entities/Post.ts": read("entities/Post.ts") } });
  try {
    expect((await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Pooled" }) })).status).toBe(201);
  } finally {
    await service.stop();
  }
});
