import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
/** The lowercase name before the rename, spelled in parts so this file does not match itself. */
const previous = ["quick", "service"].join("");
/** The previous name not followed by `ts`: the scoped packages, the command, the config file, folders and keys. */
const leftover = new RegExp(`${previous}(?!ts)`);

const trackedFiles = () =>
  Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root })
    .stdout.toString()
    .split("\0")
    .filter((file) => file !== "" && !file.startsWith("adrs/"));

test("no file name or text outside the ADRs uses the previous package scope or lowercase name", () => {
  const problems: string[] = [];
  for (const file of trackedFiles()) {
    if (leftover.test(file)) problems.push(file);
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, index) => {
      if (leftover.test(line) || line.includes(`@${previous}/`)) problems.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(problems).toEqual([]);
});
