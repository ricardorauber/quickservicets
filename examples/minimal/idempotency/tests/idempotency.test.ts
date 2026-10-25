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

const order = (key: string) => ({ method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ item: "book", quantity: 1 }) });

test("a repeated POST with one Idempotency-Key creates one order and replays the response", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const first = await service.fetch("/orders", order("checkout-1"));
    const again = await service.fetch("/orders", order("checkout-1"));
    expect([first.status, again.status, again.headers.get("idempotent-replayed")]).toEqual([201, 201, "true"]);
    expect(await again.json()).toEqual(await first.json());
    const all = (await (await service.fetch("/orders")).json()) as { data: unknown[] };
    expect(all.data).toHaveLength(1);
  } finally {
    await service.stop();
  }
});
