import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { testAuth } from "@quickservicets/core/testing";
import { checkExample } from "../../../../examples/minimal/auth/tests/support.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/auth");

/** The files of a project folder, as `startTestService` takes them, without generated, installed and test files. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!entry.isFile() || /^(node_modules|\.generated|tests)\//.test(path) || !path.endsWith(".ts")) continue;
    files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("quickservicets eject auth turns the native into features/auth/, and the example's checks still pass", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "auth");
  expect(lines).toContain("features/auth/ now replaces the auth native.");
  expect(existsSync(join(root, "features/auth/index.ts"))).toBe(true);
  expect(readFileSync(join(root, "features/auth/index.ts"), "utf8")).toContain('from "@quickservicets/core"');
  const service = await startTestService({ files: filesOf(root), env: { API_KEY: "k-123" }, auth: testAuth() });
  try {
    await checkExample(service);
  } finally {
    await service.stop();
  }
});
