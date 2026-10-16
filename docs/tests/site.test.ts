import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const docs = join(import.meta.dir, "..");
const dist = join(docs, "dist");
const page = (path: string) => readFileSync(join(dist, path), "utf8");

beforeAll(() => {
  const built = Bun.spawnSync(["bun", "run", "build"], { cwd: docs, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`docs build failed:\n${built.stdout.toString()}${built.stderr.toString()}`);
}, 300_000);

describe("site", () => {
  test("builds both locales' home pages", () => {
    expect(page("index.html")).toContain('lang="en"');
    expect(page("pt-br/index.html")).toContain('lang="pt-BR"');
  });

  test("home pages have the hero, four feature cards and the code sample", () => {
    const english = page("index.html");
    expect(english).toContain("Write your entities as TypeScript types.");
    for (const card of ["Entities as types", "Generated CRUD", "Typed queries", "API docs"]) expect(english).toContain(card);
    expect(english).toContain("entities/User.ts");
    const portuguese = page("pt-br/index.html");
    expect(portuguese).toContain("Escreva suas entidades como tipos TypeScript.");
    for (const card of ["Entidades como tipos", "CRUD gerado", "Consultas tipadas", "Documentação da API"]) expect(portuguese).toContain(card);
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

  test("the sidebar has the five groups in both locales", () => {
    const english = page("getting-started/index.html");
    for (const group of ["Getting started", "Tutorial", "Guides", "Reference", "Recipes"]) expect(english).toContain(group);
    const portuguese = page("pt-br/getting-started/index.html");
    for (const group of ["Primeiros passos", "Tutorial", "Guias", "Referência", "Receitas"]) expect(portuguese).toContain(group);
  });
});
