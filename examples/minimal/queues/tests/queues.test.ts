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
type Repos = { queueMessages: { findById(id: string): Promise<{ queue: string; status: string; payload: unknown; maxAttempts: number } | null> } };

test("a welcome request adds a waiting send-email message for the user", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const user = (await (await service.fetch("/users", send({ email: "ada@example.com" }))).json()) as { id: string };
    const added = (await (await service.fetch(`/users/${user.id}/welcome`, send())).json()) as { id: string; deduplicated: boolean };
    expect(added.deduplicated).toBe(false);
    const message = await (service.repos as unknown as Repos).queueMessages.findById(added.id);
    expect(message).toMatchObject({ queue: "send-email", status: "waiting", payload: { userId: user.id }, maxAttempts: 4 });
  } finally {
    await service.stop();
  }
});
