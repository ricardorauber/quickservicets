/** `bun run docs:reference`: writes the generated reference pages and removes the pages of natives no longer registered. */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTENT, FEATURE_PAGES_DIR, referencePages } from "./reference.ts";

const pages = referencePages();
for (const [path, content] of Object.entries(pages)) {
  const file = join(CONTENT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`Wrote ${path}`);
}
const featuresDir = join(CONTENT, FEATURE_PAGES_DIR);
for (const name of existsSync(featuresDir) ? readdirSync(featuresDir) : []) {
  const path = `${FEATURE_PAGES_DIR}/${name}`;
  if (Object.hasOwn(pages, path)) continue;
  rmSync(join(CONTENT, path));
  console.log(`Removed ${path}`);
}
