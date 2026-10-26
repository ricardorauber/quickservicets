import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/queues");

/** The files of a project folder, as `startTestService` takes them, without generated and installed files. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!entry.isFile() || /^(node_modules|\.generated|tests)\//.test(path) || !path.endsWith(".ts")) continue;
    files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Message = { status: string; result?: unknown };

test("quickservicets eject queues turns the native into features/queues/ and the example keeps processing", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "queues");
  expect(lines).toContain("features/queues/ now replaces the queues native.");
  expect(existsSync(join(root, "features/queues/index.ts"))).toBe(true);
  expect(readFileSync(join(root, "features/queues/database.ts"), "utf8")).toContain('from "@quickservicets/core"');

  const service = await startTestService({ files: filesOf(root) });
  try {
    const user = (await (await service.fetch("/users", post({ email: "ada@example.com", name: "Ada" }))).json()) as { id: string };
    const added = (await (await service.fetch(`/users/${user.id}/welcome`, post())).json()) as { id: string };
    const repos = (service.repos as unknown as { queueMessages: { findById(id: string): Promise<Message | null> } }).queueMessages;
    for (let attempt = 0; attempt < 300 && (await repos.findById(added.id))?.status !== "completed"; attempt++) await Bun.sleep(10);
    expect(await repos.findById(added.id)).toMatchObject({ status: "completed", result: { outboxId: expect.any(String) } });
  } finally {
    await service.stop();
  }
});
