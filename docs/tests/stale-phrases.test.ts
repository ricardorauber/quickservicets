import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DOCS_DIR } from "../../packages/cli/src/agents/topics.ts";
import { pagesUnder, stalePhrases } from "../scripts/checks.ts";

const root = join(import.meta.dir, "../..");
const content = join(import.meta.dir, "../src/content/docs");

/** The problems of the given files, as `<file>:<line>: <phrase>`. */
const problemsOf = (files: string[]) => files.flatMap((file) => stalePhrases(readFileSync(file, "utf8")).map((problem) => `${file}:${problem}`));

test("no page, agent topic or README describes init asking, a required config file or File and Media in every model", () => {
  const topics = readdirSync(AGENT_DOCS_DIR).filter((file) => file.endsWith(".md")).map((file) => join(AGENT_DOCS_DIR, file));
  const readmes = ["README.md", "packages/core/README.md", "packages/cli/README.md", "packages/quickservicets/README.md"].map((file) => join(root, file));
  expect(topics.length).toBeGreaterThan(0);
  expect(problemsOf([...pagesUnder(content).map((page) => join(content, page)), ...topics, ...readmes])).toEqual([]);
});

test("a stale phrase is reported with its line, with or without backticks", () => {
  expect(stalePhrases("# Quickstart\n\n- Do not leave out `--db`; `init` would wait for an answer.")).toEqual(["3: init would wait"]);
  expect(stalePhrases("Always pass it: without it, `init` asks.")).toEqual(["1: without it, init asks"]);
  expect(stalePhrases("It fails with `Config file not found`.\nThe count includes the built-in `File` and `Media` entities.")).toEqual(["1: Config file not found", "2: includes the built-in File and Media"]);
  expect(stalePhrases("`init` uses memory without `--db`.")).toEqual([]);
});
