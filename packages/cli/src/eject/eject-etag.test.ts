import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/etag");

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

const send = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("quickservice eject etag turns the native into features/etag/ and tags, 304, 412 and 428 keep working", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "etag");
  expect(lines).toContain("features/etag/ now replaces the etag native.");
  expect(existsSync(join(root, "features/etag/index.ts"))).toBe(true);
  const service = await startTestService({ files: filesOf(root) });
  try {
    const created = await service.fetch("/documents", send("POST", { title: "Plan", body: "v1" }));
    const { id } = (await created.json()) as { id: string };
    const tag = created.headers.get("etag")!;
    expect(tag).toMatch(/^".{22}"$/);
    expect((await service.fetch(`/documents/${id}`, { headers: { "if-none-match": tag } })).status).toBe(304);
    expect((await service.fetch(`/documents/${id}`, send("PATCH", { body: "x" }))).status).toBe(428);
    expect((await service.fetch(`/documents/${id}`, send("PATCH", { body: "x" }, { "if-match": tag }))).status).toBe(200);
    expect((await service.fetch(`/documents/${id}`, send("PATCH", { body: "y" }, { "if-match": tag }))).status).toBe(412);
  } finally {
    await service.stop();
  }
});
