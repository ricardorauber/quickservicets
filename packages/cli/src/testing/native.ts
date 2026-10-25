import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_FEATURES_DIR } from "@quickservice/core";

/**
 * Writes files into a native feature's folder of the core (`packages/core/src/features/<key>/`) for a test, and
 * returns a function removing the folder. Use a key no real native has.
 */
export function writeNativeFolder(key: string, files: Record<string, string>): () => void {
  const root = join(NATIVE_FEATURES_DIR, key);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return () => rmSync(root, { recursive: true, force: true });
}
