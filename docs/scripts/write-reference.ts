/** `bun run docs:reference`: writes the generated reference pages in both locales. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTENT, referencePages } from "./reference.ts";

for (const [path, content] of Object.entries(referencePages())) {
  const file = join(CONTENT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`Wrote ${path}`);
}
