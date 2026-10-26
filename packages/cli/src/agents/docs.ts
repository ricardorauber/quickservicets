import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closestName } from "@quickservicets/core";
import { readTopics, type AgentTopic } from "./topics.ts";

/** The docs pages bundled with the CLI package as Markdown, at their site path plus `.md`. */
export const DOCS_PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../docs-pages");

/** The generated reference pages `docs search` reads besides the topics. */
export const SEARCHED_REFERENCE = ["reference/cli", "reference/config", "reference/tags"] as const;

/** The most matches `docs search` prints. */
export const MAX_MATCHES = 10;

/** The result of a `docs` command: the lines to print, the error lines and the exit code. */
export interface DocsResult {
  code: number;
  lines: string[];
  errors: string[];
}

const ok = (lines: string[]): DocsResult => ({ code: 0, lines, errors: [] });

/** `quickservicets docs`: every topic with its summary, then the usage of the other forms. */
export function listTopics(topics: readonly AgentTopic[] = readTopics()): DocsResult {
  const width = Math.max(...topics.map((topic) => topic.name.length));
  return ok([
    "Agent guide topics:",
    "",
    ...topics.map((topic) => `  ${topic.name.padEnd(width)}  ${topic.summary}`),
    "",
    "Usage:",
    "  quickservicets docs <topic>          Prints a topic.",
    "  quickservicets docs <topic> --full   Prints the full docs page the topic links to (or a page by name, like queues).",
    "  quickservicets docs search <term>    Searches the topics and the CLI, config and tags reference.",
    "  --plain                              Prints without colors (the default when the output is not a terminal).",
  ]);
}

const BOLD = "\u001b[1m";
const CYAN = "\u001b[36m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/** A topic's Markdown for the terminal: as it is without colors, or with bold headings and dim code blocks. */
export function renderMarkdown(markdown: string, color: boolean): string[] {
  const lines = markdown.replace(/\n+$/, "").split("\n");
  if (!color) return lines;
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return `${DIM}${line}${RESET}`;
    }
    if (fenced) return `${DIM}${line}${RESET}`;
    if (/^#{1,6} /.test(line)) return `${BOLD}${CYAN}${line}${RESET}`;
    return line.replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`);
  });
}

/** `Unknown topic <topic>. Topics: <list>`, with the closest topic name within two edits. */
function unknownTopic(name: string, topics: readonly AgentTopic[]): DocsResult {
  const names = topics.map((topic) => topic.name);
  const near = closestName(name, names);
  return { code: 1, lines: [], errors: [`Unknown topic ${name}. Topics: ${names.join(", ")}`, ...(near ? [`Did you mean ${near}?`] : [])] };
}

/** `quickservicets docs <topic>`: the topic's Markdown. */
export function printTopic(name: string, options: { color: boolean }, topics: readonly AgentTopic[] = readTopics()): DocsResult {
  const topic = topics.find((candidate) => candidate.name === name);
  return topic ? ok(renderMarkdown(topic.markdown, options.color)) : unknownTopic(name, topics);
}

/** Every bundled page, as its path without `.md`, like `guides/queues`. */
export function bundledPages(dir: string = DOCS_PAGES_DIR): string[] {
  const walk = (folder: string, prefix: string): string[] =>
    existsSync(folder)
      ? readdirSync(folder)
          .sort()
          .flatMap((entry) => (statSync(join(folder, entry)).isDirectory() ? walk(join(folder, entry), `${prefix}${entry}/`) : entry.endsWith(".md") ? [`${prefix}${entry.slice(0, -3)}`] : []))
      : [];
  return walk(dir, "");
}

/** The bundled page a site link like `/guides/queues/#retries` points to: `guides/queues`. */
const pageOfLink = (link: string) => link.split("#")[0]!.replace(/^\/+|\/+$/g, "") || "index";

/** The folders searched for a page given by its last segment, in order. */
const PAGE_FOLDERS = ["guides", "getting-started", "recipes", "tutorial", "reference", "reference/features"];

/** The bundled page for a name: a topic's main page, a page path (`guides/queues`), or a page's last segment (`queues`). */
export function resolvePage(name: string, topics: readonly AgentTopic[], pages: readonly string[]): string | undefined {
  const topic = topics.find((candidate) => candidate.name === name);
  const link = topic?.fullDocs[0]?.path;
  if (link) return pages.includes(pageOfLink(link)) ? pageOfLink(link) : undefined;
  const path = name.replace(/^\/+|\/+$/g, "").replace(/\.md$/, "");
  if (pages.includes(path)) return path;
  return PAGE_FOLDERS.map((folder) => `${folder}/${path}`).find((candidate) => pages.includes(candidate));
}

/** `quickservicets docs <topic> --full`: the full docs page the topic links to, from the Markdown bundled with the CLI. */
export function printFullPage(name: string, options: { color: boolean }, topics: readonly AgentTopic[] = readTopics(), dir: string = DOCS_PAGES_DIR): DocsResult {
  const pages = bundledPages(dir);
  const page = resolvePage(name, topics, pages);
  if (!page) {
    const near = closestName(name, [...topics.map((topic) => topic.name), ...pages.map((path) => path.split("/").at(-1)!)]);
    return { code: 1, lines: [], errors: [`Unknown topic or page ${name}. Topics: ${topics.map((topic) => topic.name).join(", ")}`, ...(near ? [`Did you mean ${near}?`] : [])] };
  }
  return ok(renderMarkdown(readFileSync(join(dir, `${page}.md`), "utf8"), options.color));
}

/** A line's rank for a term: 0 for a heading, 1 for a table row whose first cell has it, 2 for any other line. */
function rank(line: string, term: string): number {
  if (/^#{1,6} /.test(line)) return 0;
  const cell = /^\|([^|]*)\|/.exec(line)?.[1];
  return cell?.toLowerCase().includes(term) ? 1 : 2;
}

/**
 * `quickservicets docs search <term>`: up to ten lines of the topics and of the CLI, config and tags reference that
 * contain the term, ignoring case, as `<source>: <line>`; headings first, then reference rows, then the other lines.
 */
export function searchDocs(term: string, topics: readonly AgentTopic[] = readTopics(), dir: string = DOCS_PAGES_DIR): DocsResult {
  const needle = term.toLowerCase();
  const sources: [string, string][] = [
    ...topics.map((topic): [string, string] => [topic.name, topic.markdown]),
    ...SEARCHED_REFERENCE.filter((page) => existsSync(join(dir, `${page}.md`))).map((page): [string, string] => [page, readFileSync(join(dir, `${page}.md`), "utf8")]),
  ];
  const matches = sources.flatMap(([source, markdown], order) =>
    markdown
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().includes(needle))
      .map((line, index) => ({ source, line, rank: rank(line, needle), order, index })),
  );
  matches.sort((a, b) => a.rank - b.rank || a.order - b.order || a.index - b.index);
  if (matches.length === 0) return { code: 1, lines: [], errors: [`No matches for ${term}`] };
  return ok(matches.slice(0, MAX_MATCHES).map((match) => `${match.source}: ${match.line}`));
}
