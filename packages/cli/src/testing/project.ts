import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "quickservice-"));
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

/** Creates a project whose `@quickservice/core` imports resolve to this repository's core package. */
export function createLinkedProject(files: Record<string, string>): string {
  const root = createProject(files);
  mkdirSync(join(root, "node_modules/@quickservice"), { recursive: true });
  symlinkSync(join(import.meta.dir, "../../../core"), join(root, "node_modules/@quickservice/core"), "dir");
  return root;
}

export const MEMORY_CONFIG = `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter() });
`;
