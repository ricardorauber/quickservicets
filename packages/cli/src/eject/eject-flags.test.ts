import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/flags");

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

test("quickservice eject flags turns the native into features/flags/, and the example's flags keep working", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "flags");
  expect(lines).toContain("features/flags/ now replaces the flags native.");
  expect(existsSync(join(root, "features/flags/index.ts"))).toBe(true);
  const service = await startTestService({ files: filesOf(root) });
  try {
    expect(await (await service.fetch("/settings", { headers: { "x-user-id": "u1" } })).json()).toEqual({ "checkout-v2": true, "dark-mode": true });
    expect(((await (await service.fetch("/settings")).json()) as Record<string, boolean>)["checkout-v2"]).toBe(false);
  } finally {
    await service.stop();
  }
});
