import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readTopics } from "../../packages/cli/src/agents/topics.ts";
import { llmsFiles, pageMarkdown, readPage, readPages } from "../scripts/llms.ts";
import { referencePages } from "../scripts/reference.ts";
import { REPOSITORY_URL, siteUrl } from "../scripts/site.ts";

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

describe("files for LLMs", () => {
  test("the build writes llms.txt, llms-full.txt and llms-small.txt at the site root, as the generator writes them", () => {
    const files = llmsFiles(readTopics(), readPages());
    for (const name of ["llms.txt", "llms-full.txt", "llms-small.txt"]) expect(page(name)).toBe(files[name]!);
    for (const docsPage of readPages()) expect(page("llms.txt")).toContain(`](${docsPage.markdownPath}): ${docsPage.description}`);
  });

  test("every page and agent topic is served as Markdown at its path plus .md", () => {
    expect(page("guides/queues.md")).toBe(pageMarkdown(readPage("guides/queues.md")));
    expect(page("guides/queues.md")).toStartWith("# Queues\n");
    expect(page("index.md")).toStartWith("# QuickService.ts\n");
    expect(page("agents/quickstart.md")).toStartWith("# Quickstart\n");
    for (const path of Object.keys(llmsFiles()).filter((path) => path.endsWith(".md"))) expect(existsSync(join(dist, path))).toBe(true);
  });

  test("the footer links to /llms.txt", () => {
    for (const path of ["index.html", "guides/queues/index.html"]) expect(page(path)).toContain('href="/llms.txt"');
  });
});

describe("repository links", () => {
  const editLinks = (html: string) => html.match(/href="https:\/\/github\.com\/ricardorauber\/quickservicets\/edit\/[^"]*"/g) ?? [];

  test("a hand-written page has the GitHub header link and an Edit page link to its source on main", () => {
    const html = page("getting-started/installation/index.html");
    expect(html).toMatch(/<a href="https:\/\/github\.com\/ricardorauber\/quickservicets" rel="me"[^>]*><span[^>]*>GitHub<\/span>/);
    expect(editLinks(html)).toEqual(['href="https://github.com/ricardorauber/quickservicets/edit/main/docs/src/content/docs/getting-started/installation.md"']);
  });

  test("generated reference pages set editUrl: false and show no Edit page link", () => {
    const generated = Object.entries(referencePages());
    expect(generated.length).toBeGreaterThan(0);
    for (const [path, content] of generated) {
      expect(/^---\n[\s\S]*?\n---\n/.exec(content)?.[0]).toContain("\neditUrl: false\n");
      const built = path.replace(/\/index\.mdx?$/, "/index.html").replace(/\.mdx?$/, "/index.html");
      expect(editLinks(page(built))).toEqual([]);
    }
  });

  test("the footer has the Source on GitHub line", () => {
    for (const path of ["index.html", "guides/queues/index.html", "reference/cli/index.html"]) {
      expect(page(path)).toMatch(new RegExp(`<a href="${REPOSITORY_URL}"[^>]*>Source on GitHub</a>`));
    }
  });

  test("the site URL comes from DOCS_SITE_URL, then the Vercel production domain, then none", () => {
    expect(siteUrl({ DOCS_SITE_URL: "https://docs.example.com", VERCEL_PROJECT_PRODUCTION_URL: "qs.vercel.app" })).toBe("https://docs.example.com");
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "qs.vercel.app" })).toBe("https://qs.vercel.app");
    expect(siteUrl({ DOCS_SITE_URL: "", VERCEL_PROJECT_PRODUCTION_URL: "" })).toBeUndefined();
    expect(siteUrl({})).toBeUndefined();
  });
});
