import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTopics } from "../packages/cli/src/agents/topics.ts";
import { agentsMarkdown, GENERATE_COMMAND, generatedFiles, repositoryLink, ROOT, staleFiles, unknownMentions, writeGenerated } from "./agents.ts";

/** A temporary repository root with a copy of the agent topics. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "quickservicets-agents-"));
  cpSync(join(ROOT, "packages/cli/agent-docs"), join(root, "packages/cli/agent-docs"), { recursive: true });
  return root;
}

/** The freshness check the suite runs: a message naming the command for each stale file. */
const freshness = (root: string) => staleFiles(generatedFiles(root), root).map((path) => `${path} is stale; run ${GENERATE_COMMAND}`);

describe("AGENTS.md", () => {
  test("has a 10-line header, the project section from overview and quickstart with links to the other topics, and the repository section", () => {
    const markdown = agentsMarkdown(readTopics());
    const lines = markdown.split("\n");
    const sections = lines.filter((line) => line.startsWith("## "));
    expect(sections).toEqual(["## Using QuickService.ts in a project", "## Working on this repository"]);
    expect(lines.indexOf("## Using QuickService.ts in a project")).toBe(10);
    expect(lines[0]).toBe("# QuickService.ts");
    expect(markdown).toContain("`packages/cli/agent-docs/`");
    expect(lines[8]).toContain("[/llms.txt](/llms.txt)");
    expect(markdown).toContain("### Use it when");
    expect(markdown).toContain("### Quickstart");
    expect(markdown).toContain("bunx quickservicets init my-api --db sqlite");
    for (const name of ["entities", "endpoints-and-hooks", "config-and-env", "features", "testing", "deploy", "troubleshooting"]) {
      expect(markdown).toContain(`- [${name}](packages/cli/agent-docs/${name}.md): `);
    }
    for (const text of ["Bun workspaces", "TEST_POSTGRES_URL", "bun run docs:reference", "`adrs/`", "`specs/`"]) expect(markdown).toContain(text);
    expect(markdown).toContain("[Getting started](docs/src/content/docs/getting-started/installation.md)");
  });

  test("site links point to the docs pages in the repository, keeping anchors", () => {
    expect(repositoryLink("/guides/entities/")).toBe("docs/src/content/docs/guides/entities.md");
    expect(repositoryLink("/reference/tags/#unique")).toBe("docs/src/content/docs/reference/tags.mdx#unique");
    expect(repositoryLink("/getting-started/")).toBe("docs/src/content/docs/getting-started/index.md");
    expect(repositoryLink("/no/such/page/")).toBe("/no/such/page/");
    expect(repositoryLink("https://bun.sh")).toBe("https://bun.sh");
  });

  test("the generator writes the files, and a second run changes nothing", () => {
    const root = tempRoot();
    try {
      expect(writeGenerated(root)).toEqual(["Wrote AGENTS.md"]);
      const first = readFileSync(join(root, "AGENTS.md"), "utf8");
      expect(writeGenerated(root)).toEqual(["Unchanged AGENTS.md"]);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CLAUDE.md imports AGENTS.md and nothing else", () => {
    expect(readFileSync(join(ROOT, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });
});

describe("freshness", () => {
  test("the generated files of the repository are fresh", () => {
    expect(freshness(ROOT)).toEqual([]);
  });

  test("a hand edit makes the check fail, naming the command", () => {
    const root = tempRoot();
    try {
      writeGenerated(root);
      writeFileSync(join(root, "AGENTS.md"), `${readFileSync(join(root, "AGENTS.md"), "utf8")}\nEdited by hand.\n`);
      expect(freshness(root)).toEqual(["AGENTS.md is stale; run bun run agents:generate"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("staleness of the topics' mentions", () => {
  test("every command, config key, variable and tag the topics mention exists", () => {
    expect(unknownMentions(readTopics())).toEqual([]);
  });

  test("an unknown command fails naming the topic and line", () => {
    const quickstart = readTopics().find((topic) => topic.name === "quickstart")!;
    const lines = quickstart.markdown.split("\n");
    lines.splice(5, 0, "Then run `quickservicets frobnicate`.");
    expect(unknownMentions([{ name: "quickstart", markdown: lines.join("\n") }])).toEqual(['quickstart.md:6: unknown command "quickservicets frobnicate"']);
  });

  test("known commands, groups, keys, variables, tags and hooks pass; unknown ones fail", () => {
    const markdown = [
      "Run `bunx quickservicets init my-api --db sqlite`, `bun run quickservicets migration add CreateTasks` and `quickservicets help`.",
      "Set `server.port`, `security.rateLimit.limit`, `queues.overrides`, `queues.overrides.email.retries` or `repos.tasks`.",
      "Set QS_SERVER_PORT, QS_WORKERS or QS_QUEUES_ENABLED; QS_<KEY>_ENABLED is a pattern.",
      "Tag `@unique`, `@rateLimit 10/min` and `@authorized:create admin`, with hooks/authorized.ts; `@quickservicets/core` and ana@acme.com are not tags.",
      '```ts',
      'export default job("@daily", async () => {});',
      "const port = `server.nope`;",
      "```",
      "Run `quickservicets migration`, then `quickservicets migration frob` and `quickservicets frob`.",
      "Set `server.nope`, `security.rateLimit.nope` and QS_SERVR_PORT.",
      "Tag `@uniq` and `@nope`.",
    ].join("\n");
    expect(unknownMentions([{ name: "sample", markdown }])).toEqual([
      'sample.md:9: unknown command "quickservicets migration frob"',
      'sample.md:9: unknown command "quickservicets frob"',
      "sample.md:10: unknown variable QS_SERVR_PORT",
      "sample.md:10: unknown config key server.nope",
      "sample.md:10: unknown config key security.rateLimit.nope",
      "sample.md:11: unknown tag @uniq",
      "sample.md:11: unknown tag @nope",
    ]);
  });
});
