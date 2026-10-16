import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractSnippets, missingTranslations, snippetErrors, snippetsOf } from "../scripts/checks.ts";

const docs = join(import.meta.dir, "..");
const content = join(docs, "src/content/docs");
const work = (name: string) => join(docs, ".snippets", name);

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "docs-checks-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("translation parity", () => {
  test("pages missing in either locale are named", () => {
    const root = fixture({ "a.md": "", "guides/b.md": "", "pt-br/a.md": "", "pt-br/only.mdx": "" });
    expect(missingTranslations(root)).toEqual(["pt-br/guides/b.md", "only.mdx"]);
  });

  test("every page of the site exists in English and Portuguese", () => {
    expect(missingTranslations(content)).toEqual([]);
  });
});

describe("snippet extraction", () => {
  test("only ts check blocks, with their line, several per page", () => {
    const page = "# Title\n\n```ts check title=\"a.ts\"\nconst a = 1;\n```\n\n```ts\nnot checked\n```\n\n```ts check\nconst b = 2;\nconst c = 3;\n```\n";
    expect(extractSnippets("guide.md", page)).toEqual([
      { page: "guide.md", line: 3, code: "const a = 1;" },
      { page: "guide.md", line: 11, code: "const b = 2;\nconst c = 3;" },
    ]);
  });
});

describe("type-checking", () => {
  const repoSnippet = (method: string) => ({
    page: "guides/queries.md",
    line: 10,
    code: `import type { Repository } from "@quickservice/core";\ntype User = { id: string; createdAt: Date; updatedAt: Date; email: string };\ndeclare const users: Repository<User>;\nexport const found = users.${method}((u) => u.email.eq("a")).all();`,
  });

  test("a broken snippet fails with page, line and message; the fixed one passes", () => {
    const errors = snippetErrors([repoSnippet("wher")], work("broken"));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/^guides\/queries\.md:14: Property 'wher' does not exist/);
    expect(snippetErrors([repoSnippet("where")], work("fixed"))).toEqual([]);
  });

  test("every checked snippet of the site compiles", () => {
    expect(snippetErrors(snippetsOf(content), work("site"))).toEqual([]);
  });
});
