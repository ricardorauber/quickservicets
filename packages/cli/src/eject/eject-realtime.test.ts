import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/realtime");

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

/** The first message of a stream, then the stream is closed. */
async function firstMessage(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  return text.slice(0, text.indexOf("\n\n"));
}

test("quickservice eject realtime turns the native into features/realtime/, and streams and change streams keep working", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "realtime");
  expect(lines).toContain("features/realtime/ now replaces the realtime native.");
  expect(existsSync(join(root, "features/realtime/index.ts"))).toBe(true);
  const service = await startTestService({ files: filesOf(root) });
  try {
    expect(await firstMessage(await service.fetch("/clock"))).toMatch(/^data: \{"now":"/);
    const changes = await service.fetch("/tasks/changes?where[status][eq]=open");
    const read = firstMessage(changes);
    await service.fetch("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Review", status: "open" }) });
    expect(await read).toMatch(/^event: created\nid: .+\nretry: 3000\ndata: \{"id":/);
  } finally {
    await service.stop();
  }
});
