import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registeredNatives } from "../packages/core/src/index.ts";
import { LEVEL_HEADINGS, minimalExampleProblems } from "./minimal-examples.ts";

const repository = join(import.meta.dir, "..");

const repo = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "qs-examples-"));
  mkdirSync(join(root, "examples/minimal"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const README = (skip: string[] = [], empty: string[] = []) =>
  [
    "# audit",
    "",
    ...LEVEL_HEADINGS.filter((heading) => !skip.includes(heading)).flatMap((heading) => [
      `## ${heading}`,
      "",
      ...(empty.includes(heading) ? ["Some words."] : heading.startsWith("Level 3") ? ["Not applicable: audit has no per-request option."] : ["```ts", "audit: {}", "```"]),
      "",
    ]),
  ].join("\n");

const complete = (extra: Record<string, string> = {}) => ({
  "examples/minimal/audit/package.json": JSON.stringify({ name: "minimal-audit", dependencies: { "@quickservice/core": "workspace:*", "@quickservice/cli": "workspace:*" } }),
  "examples/minimal/audit/quickservice.config.ts": "export default defineConfig({ database: memoryAdapter(), audit: {} });\n",
  "examples/minimal/audit/README.md": README(),
  "examples/minimal/audit/tests/audit.test.ts": 'import { startTestService } from "@quickservice/cli/testing";\n',
  ...extra,
});

const audit = [{ key: "audit", enabledByDefault: false }];

describe("the repository", () => {
  test("every registered native has a complete minimal example, and every minimal folder is known", () => {
    const problems = minimalExampleProblems(repository, registeredNatives());
    if (problems.length > 0) throw new Error(problems.join("\n"));
  });
});

describe("folders and files", () => {
  test("a native without a folder is reported", () => {
    expect(minimalExampleProblems(repo({}), audit)).toEqual(["examples/minimal/audit: missing folder"]);
  });

  test("missing files, a config that does not enable the native and tests without startTestService are reported", () => {
    const root = repo({ "examples/minimal/audit/quickservice.config.ts": "export default defineConfig({});\n", "examples/minimal/audit/tests/a.test.ts": "test();\n" });
    expect(minimalExampleProblems(root, audit)).toEqual([
      "examples/minimal/audit: missing package.json",
      "examples/minimal/audit: quickservice.config.ts does not enable audit",
      "examples/minimal/audit: missing README.md",
      "examples/minimal/audit: tests must start the project with startTestService",
    ]);
    expect(minimalExampleProblems(root, [{ key: "audit", enabledByDefault: true }])).not.toContain("examples/minimal/audit: quickservice.config.ts does not enable audit");
  });

  test("a complete example passes", () => {
    expect(minimalExampleProblems(repo(complete()), audit)).toEqual([]);
  });
});

describe("README levels", () => {
  test("a missing heading and a section without a sample or a reason are two lines of one report", () => {
    const root = repo(complete({ "examples/minimal/audit/README.md": README(["Level 2: tags"], ["Level 5: override files"]) }));
    expect(minimalExampleProblems(root, audit)).toEqual([
      "examples/minimal/audit: missing README heading Level 2: tags",
      "examples/minimal/audit: README section Level 5: override files has no code sample or Not applicable: line",
    ]);
  });

  test("headings out of order are reported", () => {
    const swapped = README().replace("## Level 0: enable", "## Level 0 placeholder").replace("## Level 7: eject", "## Level 0: enable\n\n```ts\naudit: {}\n```\n\n## Level 7: eject");
    const problems = minimalExampleProblems(repo(complete({ "examples/minimal/audit/README.md": swapped })), audit);
    expect(problems).toContain("examples/minimal/audit: README heading Level 1: options and environment is out of order");
  });
});

describe("other folders", () => {
  test("plugin-<key> of an existing package is not checked, and an unknown folder fails", () => {
    const root = repo(complete({ "packages/plugin-demo/package.json": "{}", "examples/minimal/plugin-demo/README.md": "# demo\n", "examples/minimal/nope/README.md": "# nope\n" }));
    expect(minimalExampleProblems(root, audit)).toEqual([
      "examples/minimal/nope: unknown folder; minimal examples are named after a native key, or plugin-<key> for a packages/plugin-<key> package",
    ]);
    expect(minimalExampleProblems(repo({ "examples/minimal/plugin-gone/README.md": "x" }), [])).toHaveLength(1);
  });
});
