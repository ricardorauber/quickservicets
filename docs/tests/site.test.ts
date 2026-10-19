import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const docs = join(import.meta.dir, "..");
const dist = join(docs, "dist");
const page = (path: string) => readFileSync(join(dist, path), "utf8");

beforeAll(() => {
  const built = Bun.spawnSync(["bun", "run", "build"], { cwd: docs, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`docs build failed:\n${built.stdout.toString()}${built.stderr.toString()}`);
}, 300_000);

describe("site", () => {
  test("builds the English home page and no other locale", () => {
    expect(page("index.html")).toContain('lang="en"');
    expect(existsSync(join(dist, "pt-br"))).toBe(false);
  });

  test("the home page has the hero, four feature cards and the code sample", () => {
    const html = page("index.html");
    expect(html).toContain("Write your entities as TypeScript types.");
    for (const card of ["Entities as types", "Generated CRUD", "Typed queries", "API docs"]) expect(html).toContain(card);
    expect(html).toContain("entities/User.ts");
  });

  test("the accent is indigo #4F46E5 and the header shows the logo", () => {
    const css = readdirSync(join(dist, "_astro"))
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(join(dist, "_astro", file), "utf8"))
      .join("\n")
      .toLowerCase();
    expect(css).toContain("#4f46e5");
    expect(page("index.html")).toMatch(/<img[^>]+logo[^>]+\.svg/);
  });

  test("the sidebar has the five groups", () => {
    const html = page("getting-started/index.html");
    for (const group of ["Getting started", "Tutorial", "Guides", "Reference", "Recipes"]) expect(html).toContain(group);
  });
});
