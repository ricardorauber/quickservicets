import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const dir of ["entities", "endpoints", "queues"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const send = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Repos = { queueMessages: { findById(id: string): Promise<{ queue: string; status: string; payload: unknown; result?: unknown } | null> } };
const settle = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 300 && !(await check()); attempt++) await Bun.sleep(10);
};

test("a welcome request adds a send-email message, which the consumer completes", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const user = (await (await service.fetch("/users", send({ email: "ada@example.com" }))).json()) as { id: string };
    const added = (await (await service.fetch(`/users/${user.id}/welcome`, send())).json()) as { id: string; deduplicated: boolean };
    expect(added.deduplicated).toBe(false);
    const messages = (service.repos as unknown as Repos).queueMessages;
    await settle(async () => (await messages.findById(added.id))?.status === "completed");
    expect(await messages.findById(added.id)).toMatchObject({ queue: "send-email", status: "completed", payload: { userId: user.id }, result: { sentTo: "ada@example.com" } });
  } finally {
    await service.stop();
  }
});
