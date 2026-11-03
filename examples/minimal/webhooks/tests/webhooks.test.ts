import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { webhooks } from "@quickservicets/core";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const entry of readdirSync(join(root, "entities"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("a subscription to order and invoice events gets a secret once; order.deleted is not deliverable", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const created = await webhooks.subscriptions.create({ url: "https://hooks.example/orders", events: ["order.created", "invoice.paid"] });
    expect(created.secret).toMatch(/^whsec_/);
    expect(await webhooks.subscriptions.get(created.id)).not.toHaveProperty("secret");
    await expect(webhooks.subscriptions.create({ url: "https://hooks.example/orders", events: ["order.deleted"] })).rejects.toThrow("Invalid body");
  } finally {
    await service.stop();
  }
});
