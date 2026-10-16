import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

const project = () =>
  createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "entities/User.ts": "export type User = { email: string }" });

const generated = (root: string) => join(root, ".generated");
const PAST = new Date("2020-01-01T00:00:00Z");

/** Sets every generated file's modification time to the past, so a rewrite shows up as a new time. */
function age(root: string) {
  for (const file of readdirSync(generated(root))) utimesSync(join(generated(root), file), PAST, PAST);
}
const times = (root: string) =>
  Object.fromEntries(readdirSync(generated(root)).map((file) => [file, statSync(join(generated(root), file)).mtimeMs]));

describe("in-place updates", () => {
  test("unchanged files and the folder are left as they are", async () => {
    const root = project();
    await build(root);
    age(root);
    const inode = statSync(generated(root)).ino;
    await build(root);
    expect(Object.values(times(root)).every((time) => time === PAST.getTime())).toBe(true);
    expect(statSync(generated(root)).ino).toBe(inode);
  });

  test("only changed files are rewritten", async () => {
    const root = project();
    await build(root);
    age(root);
    const inode = statSync(generated(root)).ino;
    writeFileSync(join(root, "entities/User.ts"), "export type User = { email: string; name?: string }");
    await build(root);
    const rewritten = Object.entries(times(root))
      .filter(([, time]) => time !== PAST.getTime())
      .map(([file]) => file)
      .sort();
    expect(rewritten).toEqual(["models.ts", "openapi.json", "types.ts"]);
    expect(readFileSync(join(generated(root), "types.ts"), "utf8")).toContain("name?: string | null;");
    expect(statSync(generated(root)).ino).toBe(inode);
  });

  test("files no longer generated are deleted", async () => {
    const root = project();
    await build(root);
    writeFileSync(join(generated(root), "old.ts"), "export {};");
    mkdirSync(join(generated(root), "leftover"));
    await build(root);
    expect(existsSync(join(generated(root), "old.ts"))).toBe(false);
    expect(existsSync(join(generated(root), "leftover"))).toBe(false);
  });

  test("a failing build writes nothing", async () => {
    const root = project();
    await build(root);
    const before = Object.fromEntries(readdirSync(generated(root)).map((file) => [file, readFileSync(join(generated(root), file), "utf8")]));
    age(root);
    writeFileSync(join(root, "entities/User.ts"), "export type User = { email: Map<string, string> }");
    await expect(build(root)).rejects.toThrow();
    const after = Object.fromEntries(readdirSync(generated(root)).map((file) => [file, readFileSync(join(generated(root), file), "utf8")]));
    expect(after).toEqual(before);
    expect(Object.values(times(root)).every((time) => time === PAST.getTime())).toBe(true);
  });

  test("an old staging folder is removed and none is created", async () => {
    const root = project();
    mkdirSync(join(root, ".generated.staging"));
    writeFileSync(join(root, ".generated.staging", "models.ts"), "stale");
    await build(root);
    expect(existsSync(join(root, ".generated.staging"))).toBe(false);
    await build(root);
    expect(readdirSync(root)).not.toContain(".generated.staging");
  });
});
