import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { registerProjectFeatures } from "@quickservicets/core";
import { eject } from "../eject/eject.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";

afterEach(() => registerProjectFeatures([]));

/** The TypeScript files of a folder, by relative path, without tests and generated files. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (entry.isFile() && path.endsWith(".ts") && !/^(node_modules|\.generated|tests|dist)\//.test(path)) files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("the ejected registry native replaces the native and the example's service keeps registering and discovering", async () => {
  const example = join(import.meta.dir, "../../../../examples/minimal/registry");
  const root = createLinkedProject(filesOf(example));
  expect(await eject(root, "registry")).toContain("features/registry/ now replaces the registry native.");
  const files = filesOf(root);
  expect(Object.keys(files).some((path) => path.startsWith("features/registry/"))).toBe(true);
  const service = await startTestService({ files });
  try {
    const ready = (await (await service.fetch("/health/ready")).json()) as { checks: Record<string, { status: string }> };
    expect(ready.checks.registry?.status).toBe("ok");
  } finally {
    await service.stop();
  }
});
