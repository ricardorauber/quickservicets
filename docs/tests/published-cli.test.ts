import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pagesUnder, repositoryOnlyMentions } from "../scripts/checks.ts";

const root = join(import.meta.dir, "../..");
const content = join(import.meta.dir, "../src/content/docs");

test("pages and the README create projects with the published CLI, outside the Working from a clone section", () => {
  const files = [...pagesUnder(content).map((page) => join(content, page)), join(root, "README.md")];
  const problems = files.flatMap((file) => repositoryOnlyMentions(readFileSync(file, "utf8")).map((problem) => `${file}:${problem}`));
  expect(problems).toEqual([]);
});

test("the installation page has the Working from a clone section, which may link the workspace packages", () => {
  const installation = readFileSync(join(content, "getting-started/installation.md"), "utf8");
  expect(installation).toContain("## Working from a clone");
  expect(installation).toContain("bunx quickservicets init examples/my-api");
  expect(installation).toContain("bunx quickservicets init my-api --db memory");
});

test("a page that reintroduces repository-only instructions is rejected", () => {
  expect(repositoryOnlyMentions("# Start\n\nRun `bun packages/cli/src/index.ts init x`.\n")).toEqual(["3: packages/cli/src/index.ts"]);
  expect(repositoryOnlyMentions("The packages are not on npm yet.\n")).toEqual(["1: not on npm"]);
  expect(repositoryOnlyMentions("```bash\nbunx quickservicets init examples/app --db memory\n```\n")).toEqual(["2: a project created under examples/"]);
  const clone = "## Working from a clone\n\nbunx quickservicets init examples/app\n\n### Details\n\nbun packages/cli/src/index.ts\n\n## Next\n\nnot on npm\n";
  expect(repositoryOnlyMentions(clone)).toEqual(["11: not on npm"]);
});
