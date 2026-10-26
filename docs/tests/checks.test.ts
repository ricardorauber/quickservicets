import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { extractSnippets, snippetErrors, snippetsOf } from "../scripts/checks.ts";

const docs = join(import.meta.dir, "..");
const content = join(docs, "src/content/docs");
const work = (name: string) => join(docs, ".snippets", name);

describe("snippet extraction", () => {
  test("only ts check blocks, with their line, several per page", () => {
    const page = "# Title\n\n```ts check title=\"a.ts\"\nconst a = 1;\n```\n\n```ts\nnot checked\n```\n\n```ts check\nconst b = 2;\nconst c = 3;\n```\n";
    expect(extractSnippets("guide.md", page)).toEqual([
      { page: "guide.md", line: 3, code: "const a = 1;", title: "a.ts" },
      { page: "guide.md", line: 11, code: "const b = 2;\nconst c = 3;" },
    ]);
  });
});

describe("type-checking", () => {
  test("titled snippets of a page form a project; pages are checked separately", () => {
    const user = { page: "a.md", line: 1, title: "entities/User.ts", code: "export type User = { email: string };" };
    const organization = {
      page: "a.md",
      line: 5,
      title: "entities/Organization.ts",
      code: 'import type { User } from "./User";\nexport type Organization = { members: User[] };',
    };
    const other = { page: "b.md", line: 1, code: "export type User = { id: number };" };
    expect(snippetErrors([user, organization, other], work("project"))).toEqual([]);
    const broken = { page: "c.md", line: 3, title: "entities/Team.ts", code: 'import type { User } from "./User";\nexport type Team = { users: User[] };' };
    expect(snippetErrors([broken], work("missing"))[0]).toMatch(/^c\.md:4: Cannot find module '\.\/User'/);
  });

  const repoSnippet = (method: string) => ({
    page: "guides/queries.md",
    line: 10,
    code: `import type { Repository } from "@quickservicets/core";\ntype User = { id: string; createdAt: Date; updatedAt: Date; email: string };\ndeclare const users: Repository<User>;\nexport const found = users.${method}((u) => u.email.eq("a")).all();`,
  });

  test("a broken snippet fails with page, line and message; the fixed one passes", () => {
    const errors = snippetErrors([repoSnippet("wher")], work("broken"));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/^guides\/queries\.md:14: Property 'wher' does not exist/);
    expect(snippetErrors([repoSnippet("where")], work("fixed"))).toEqual([]);
  });

  test("every checked snippet of the site compiles", () => {
    expect(snippetErrors(snippetsOf(content), work("site"))).toEqual([]);
  }, 60_000);
});
