import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { webhooks } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/webhooks");

/** The files of a project folder, as `startTestService` takes them, without generated, installed and test files. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!entry.isFile() || /^(node_modules|\.generated|tests|migrations)\//.test(path) || !path.endsWith(".ts")) continue;
    files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("quickservicets eject webhooks turns the native into features/webhooks/ and subscriptions still get deliveries", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "webhooks");
  expect(lines).toContain("features/webhooks/ now replaces the webhooks native.");
  expect(existsSync(join(root, "features/webhooks/index.ts"))).toBe(true);
  expect(existsSync(join(root, "features/webhooks/queues/deliver.ts"))).toBe(true);
  const service = await startTestService({ files: filesOf(root) });
  try {
    const created = await webhooks.subscriptions.create({ url: "https://hooks.example/orders", events: ["order.created"] });
    expect(created.secret).toMatch(/^whsec_/);
    await service.fetch("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "new", total: 1 }) });
    const rows = () => (service.repos as unknown as { webhookDeliveries: { query(): { toArray(): Promise<{ type: string; attempt: number; status: string }[]> } } }).webhookDeliveries.query().toArray();
    expect((await rows()).map((row) => row.type)).toEqual(["order.created"]);
    // The first attempt (to a host that does not resolve) ends before the service stops.
    for (let index = 0; index < 200; index++) {
      const [row] = await rows();
      if (row && row.attempt >= 1 && row.status !== "delivering") break;
      await Bun.sleep(25);
    }
    expect((await rows())[0]).toMatchObject({ attempt: 1, status: "pending" });
  } finally {
    await service.stop();
  }
});
