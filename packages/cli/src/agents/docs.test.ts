import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../run.ts";
import { bundledPages, DOCS_PAGES_DIR, listTopics, MAX_MATCHES, printFullPage, printTopic, renderMarkdown, resolvePage, searchDocs } from "./docs.ts";
import { readTopics, TOPIC_NAMES } from "./topics.ts";

const topics = readTopics();

/** Runs `quickservicets <args>`, collecting what it prints. */
async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, tmpdir());
  return { code, out, err };
}

describe("docs", () => {
  test("lists every topic with its summary, and the usage of the other forms", async () => {
    const { code, out } = await cli("docs");
    expect(code).toBe(0);
    for (const topic of topics) expect(out).toContainEqual(expect.stringMatching(new RegExp(`^  ${topic.name} +${topic.summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)));
    expect(out.filter((line) => /^ {2}[a-z-]+ {2,}/.test(line) && !line.includes("quickservicets")).length).toBe(TOPIC_NAMES.length);
    for (const form of ["quickservicets docs <topic>", "quickservicets docs <topic> --full", "quickservicets docs search <term>", "--plain"]) expect(out.join("\n")).toContain(form);
    expect(listTopics(topics).lines).toEqual(out);
  });
});

describe("docs <topic>", () => {
  test("prints the topic's Markdown as plain text when not a terminal or with --plain", async () => {
    const quickstart = topics.find((topic) => topic.name === "quickstart")!;
    const { code, out } = await cli("docs", "quickstart");
    expect(code).toBe(0);
    expect(out.join("\n")).toBe(quickstart.markdown.trimEnd());
    expect(out.join("\n")).not.toContain("\u001b[");
    expect((await cli("docs", "quickstart", "--plain")).out).toEqual(out);
  });

  test("colors headings and code only for a terminal", () => {
    const lines = renderMarkdown("# Title\n\nRun `bun test`.\n\n```bash\nbun test\n```\n", true);
    expect(lines[0]).toBe("\u001b[1m\u001b[36m# Title\u001b[0m");
    expect(lines[2]).toBe("Run \u001b[36mbun test\u001b[0m.");
    expect(lines[5]).toBe("\u001b[2mbun test\u001b[0m");
    expect(renderMarkdown("# Title\n", false)).toEqual(["# Title"]);
  });

  test("an unknown topic exits 1 listing the topics and suggesting the closest one within two edits", async () => {
    expect(await cli("docs", "quikstart")).toEqual({
      code: 1,
      out: [],
      err: [`Unknown topic quikstart. Topics: ${TOPIC_NAMES.join(", ")}`, "Did you mean quickstart?"],
    });
    expect((await cli("docs", "nothing-like-it")).err).toEqual([`Unknown topic nothing-like-it. Topics: ${TOPIC_NAMES.join(", ")}`]);
    expect(printTopic("deploy", { color: false }, topics).code).toBe(0);
  });
});

describe("docs search <term>", () => {
  test("finds the security option and the @rateLimit tag, ignoring case, at most ten lines as <source>: <line>", async () => {
    const { code, out } = await cli("docs", "search", "RATELIMIT");
    expect(code).toBe(0);
    expect(out.length).toBeLessThanOrEqual(MAX_MATCHES);
    expect(out).toContain("reference/config: #### `@rateLimit`");
    expect(out.some((line) => line.startsWith("reference/config: | `security.rateLimit.limit` |"))).toBe(true);
    for (const line of out) expect(line).toMatch(/^[a-z/-]+: .*ratelimit/i);
  });

  test("searches the topics too, and reports a term with no match", () => {
    expect(searchDocs("startTestService", topics).lines.some((line) => line.startsWith("testing: "))).toBe(true);
    expect(searchDocs("migration add", topics).lines.some((line) => line.startsWith("reference/cli: "))).toBe(true);
    expect(searchDocs("no-such-term-anywhere", topics)).toEqual({ code: 1, lines: [], errors: ["No matches for no-such-term-anywhere"] });
  });
});

describe("docs <topic> --full", () => {
  test("prints the bundled page a topic links to, or a page by name", async () => {
    const queues = await cli("docs", "queues", "--full");
    expect(queues.code).toBe(0);
    expect(queues.out.join("\n")).toBe(readFileSync(join(DOCS_PAGES_DIR, "guides/queues.md"), "utf8").trimEnd());
    expect(queues.out[0]).toBe("# Queues");
    const entities = await cli("docs", "entities", "--full");
    expect(entities.out[0]).toBe("# Entities and tags");
    expect(printFullPage("reference/cli", { color: false }, topics).lines[0]).toBe("# CLI");
    expect((await cli("docs", "quees", "--full")).err).toEqual([`Unknown topic or page quees. Topics: ${TOPIC_NAMES.join(", ")}`, "Did you mean queues?"]);
  });

  test("resolves names in the bundle, with the topic's first Full docs link first", () => {
    const pages = bundledPages();
    expect(pages).toContain("guides/queues");
    expect(pages).toContain("reference/features/queues");
    expect(resolvePage("queues", topics, pages)).toBe("guides/queues");
    expect(resolvePage("quickstart", topics, pages)).toBe("getting-started/installation");
    expect(resolvePage("overview", topics, pages)).toBe("getting-started");
    expect(resolvePage("guides/queues.md", topics, pages)).toBe("guides/queues");
    expect(resolvePage("nope", topics, pages)).toBeUndefined();
  });

  test("reads the pages from the bundle folder it is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "quickservicets-docs-"));
    try {
      mkdirSync(join(dir, "guides"), { recursive: true });
      writeFileSync(join(dir, "guides/queues.md"), "# Bundled queues\n");
      expect(printFullPage("queues", { color: false }, topics, dir).lines).toEqual(["# Bundled queues"]);
      expect(printFullPage("entities", { color: false }, topics, dir).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
