import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineFeature, registeredNatives, registerNative } from "../../packages/core/src/index.ts";
import { unregisterNative } from "../../packages/core/src/features.ts";

const root = join(import.meta.dir, "../..");
const content = join(import.meta.dir, "../src/content/docs");
const guide = readFileSync(join(content, "guides/features.md"), "utf8");

/** The rows of the guide's table of natives, by key. */
function tableRows(markdown: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  const section = markdown.split("## Every native")[1]?.split("\n## ")[0] ?? "";
  for (const line of section.split("\n")) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const key = /^`([a-z][a-z0-9-]*)`$/.exec(cells[0] ?? "")?.[1];
    if (key) rows.set(key, cells);
  }
  return rows;
}

/** The problems between the guide's table and the registered natives: each missing or unknown key. */
function tableProblems(markdown: string, keys: readonly string[]): string[] {
  const listed = [...tableRows(markdown).keys()];
  return [
    ...keys.filter((key) => !listed.includes(key)).map((key) => `guides/features.md: the native ${key} is missing from the table`),
    ...listed.filter((key) => !keys.includes(key)).map((key) => `guides/features.md: ${key} is in the table but is not a registered native`),
  ];
}

/** The page a site link points to. */
const pageOf = (link: string) => {
  const path = link.replace(/^\//, "").replace(/\/$/, "");
  return ["md", "mdx"].map((extension) => join(content, `${path}.${extension}`)).find((file) => existsSync(file));
};

describe("the native features guide", () => {
  test("its table lists exactly the registered natives", () => {
    expect(tableProblems(guide, registeredNatives().map((native) => native.key))).toEqual([]);
  });

  test("a native registered without a row fails, naming its key", () => {
    const audit = defineFeature({ key: "audit-trail", docs: { summary: "Test native." } });
    registerNative(audit);
    try {
      expect(tableProblems(guide, registeredNatives().map((native) => native.key))).toEqual(["guides/features.md: the native audit-trail is missing from the table"]);
    } finally {
      unregisterNative("audit-trail");
    }
  });

  test("security and http are on by default, the requirements are shown, and every row links to a guide and a reference page that exist", () => {
    const rows = tableRows(guide);
    for (const [key, cells] of rows) {
      expect(cells[2]).toBe(key === "security" || key === "http" ? "by default" : "by its key");
      const links = [...cells.join(" ").matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
      expect(links).toHaveLength(2);
      for (const link of links) expect(pageOf(link)).toBeDefined();
      expect(links[1]).toBe(`/reference/features/${key}/`);
    }
    expect(rows.get("history")![3]).toBe("`events`");
    expect(rows.get("realtime")![3]).toContain("`events`");
    expect(rows.get("queues")![3]).toContain("`@publish` needs `events`");
    expect(guide).toContain("`<key>: false` or `QS_<KEY>_ENABLED=false`");
  });

  test("it has the customization levels and links to the project features guide", () => {
    expect(guide).toContain("## The customization levels");
    for (const level of ["**Enable**", "**Options and environment**", "**Tags**", "**Per request**", "**Hooks and events**", "**Override files**", "**Replace the implementation**", "**Eject**"]) expect(guide).toContain(level);
    expect(guide).toContain("(/guides/project-features/)");
  });

  test("the README has a short Native features section linking to it, and the guides index lists it first", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const section = readme.split("## Native features\n")[1]!.split("\n## ")[0]!.trim().split("\n");
    expect(section.length + 1).toBeLessThanOrEqual(10);
    expect(section.join("\n")).toContain("(docs/src/content/docs/guides/features.md)");
    const index = readFileSync(join(content, "guides/index.md"), "utf8");
    const guides = [...index.matchAll(/^- \[[^\]]+\]\(([^)]+)\)/gm)].map((match) => match[1]);
    expect(guides[0]).toBe("/guides/features/");
    expect(guides).toContain("/guides/http-client/");
  });
});
