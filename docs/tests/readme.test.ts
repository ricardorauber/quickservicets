import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const headings = [...readme.matchAll(/^#{1,6} (.+)$/gm)].map((match) => match[1]!.trim());

test("the README is a short introduction that sends readers to the Getting started docs", () => {
  expect(headings[0]).toBe("QuickService.ts");
  expect(headings).toEqual(expect.arrayContaining(["Documentation", "Using PostgreSQL or MongoDB", "Running the tests"]));
  expect(headings).not.toContain("Trying it out");
  expect(headings).not.toContain("Cleaning up");
  expect(readme).toContain("bun run docs:dev");
  expect(readme).toContain("bun run docs:build");

  const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
  const gettingStarted = links.find((link) => link.includes("getting-started"));
  expect(gettingStarted).toBeDefined();
  expect(existsSync(join(root, gettingStarted!))).toBe(true);

  const bracketedCurls = readme.split("\n").filter((line) => /\bcurl\b/.test(line) && /\[|\]/.test(line));
  for (const line of bracketedCurls) expect(line).toMatch(/\bcurl\b.*\s-g\b/);
});
