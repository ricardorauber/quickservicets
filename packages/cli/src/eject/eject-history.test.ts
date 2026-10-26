import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/history");

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

const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("quickservicets eject history turns the native into features/history/, and versions, routes and the job keep working", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "history");
  expect(lines).toContain("features/history/ now replaces the history native.");
  expect(existsSync(join(root, "features/history/index.ts"))).toBe(true);
  expect(existsSync(join(root, "features/history/jobs/prune.ts"))).toBe(true);
  const service = await startTestService({ files: filesOf(root) });
  try {
    const { id } = (await (await service.fetch("/documents", send("POST", { title: "Plan", body: "v1", secretNote: "s" }))).json()) as { id: string };
    await service.fetch(`/documents/${id}`, send("PATCH", { body: "v2" }));
    const list = (await (await service.fetch(`/documents/${id}/history`)).json()) as { total: number; data: { version: number; record: Record<string, unknown> }[] };
    expect([list.total, list.data.map((version) => version.version)]).toEqual([2, [2, 1]]);
    expect(Object.keys(list.data[0]!.record)).not.toContain("secretNote");
    expect((await service.fetch(`/documents/${id}/history/1`)).status).toBe(200);
    const draft = (await (await service.fetch("/drafts", send("POST", { text: "idea" }))).json()) as { id: string };
    expect((await service.fetch(`/drafts/${draft.id}/history`)).status).toBe(404);
  } finally {
    await service.stop();
  }
});
