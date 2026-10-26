import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globbedCurlCommands, pagesUnder } from "../scripts/checks.ts";

const root = join(import.meta.dir, "../..");
const content = join(import.meta.dir, "../src/content/docs");

test("curl commands with brackets in the query string pass -g, in every page and the README", () => {
  const files = [...pagesUnder(content).map((page) => join(content, page)), join(root, "README.md")];
  const problems = files.flatMap((file) => globbedCurlCommands(readFileSync(file, "utf8")).map((problem) => `${file}:${problem}`));
  expect(problems).toEqual([]);
});

test("a curl command with brackets and no -g is rejected", () => {
  expect(globbedCurlCommands('curl "localhost:3000/users?where[role][eq]=admin"')).toEqual(['1: curl "localhost:3000/users?where[role][eq]=admin"']);
  expect(globbedCurlCommands('curl -g "localhost:3000/users?where[role][eq]=admin"')).toEqual([]);
  expect(globbedCurlCommands('curl -gN "localhost:3000/tasks/changes?where[status][eq]=open"')).toEqual([]);
  expect(globbedCurlCommands("curl -X POST localhost:3000/users -d '{\"tags\":[\"a\"]}'")).toEqual([]);
});
