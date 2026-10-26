import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder of the agent guide topics, shipped with the CLI package (found from Node too, for the docs build). */
export const AGENT_DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../agent-docs");

/** The agent guide topics, in reading order. */
export const TOPIC_NAMES = [
  "overview",
  "quickstart",
  "entities",
  "endpoints-and-hooks",
  "config-and-env",
  "features",
  "testing",
  "deploy",
  "troubleshooting",
] as const;

/** The most lines a topic may have. */
export const MAX_TOPIC_LINES = 150;

/** One agent guide topic. */
export interface AgentTopic {
  name: string;
  /** The text of its `# ` heading. */
  title: string;
  /** Its one-line summary, the first paragraph after the heading. */
  summary: string;
  markdown: string;
  /** The docs pages of its `Full docs:` line, the first one being its main page. */
  fullDocs: { title: string; path: string }[];
}

const FULL_DOCS = /^Full docs: /;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Parses a topic's Markdown. */
export function parseTopic(name: string, markdown: string): AgentTopic {
  const lines = markdown.split("\n");
  const title = /^# (.+)$/.exec(lines[0] ?? "")?.[1]?.trim() ?? "";
  const summary = lines[1] === "" ? (lines[2] ?? "").trim() : "";
  const fullLine = lines.find((line) => FULL_DOCS.test(line)) ?? "";
  const fullDocs = [...fullLine.matchAll(LINK)].map((match) => ({ title: match[1]!, path: match[2]! }));
  return { name, title, summary, markdown, fullDocs };
}

/** Every topic, read from `dir`, in reading order. */
export function readTopics(dir: string = AGENT_DOCS_DIR): AgentTopic[] {
  return TOPIC_NAMES.map((name) => parseTopic(name, readFileSync(join(dir, `${name}.md`), "utf8")));
}

/**
 * What breaks the topic format: a `# ` heading on the first line followed by a one-line summary, at most
 * `MAX_TOPIC_LINES` lines, a `Full docs:` line with a link and a `## Do not` list.
 */
export function topicFormatProblems(topic: AgentTopic): string[] {
  const problems: string[] = [];
  const lines = topic.markdown.replace(/\n$/, "").split("\n");
  if (!topic.title) problems.push(`${topic.name}: the first line must be a "# " heading`);
  if (!topic.summary || lines[3] !== "") problems.push(`${topic.name}: the heading must be followed by a one-line summary and a blank line`);
  if (lines.length > MAX_TOPIC_LINES) problems.push(`${topic.name}: ${lines.length} lines, more than ${MAX_TOPIC_LINES}`);
  if (topic.fullDocs.length === 0) problems.push(`${topic.name}: no "Full docs:" line with a link to the docs`);
  const doNot = lines.indexOf("## Do not");
  const items = doNot < 0 ? [] : lines.slice(doNot + 1).filter((line) => line.startsWith("- Do not "));
  if (items.length === 0) problems.push(`${topic.name}: no "## Do not" list of "- Do not ..." items`);
  return problems;
}
