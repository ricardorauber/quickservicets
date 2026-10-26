/**
 * The Markdown versions of the docs site for LLMs and agents (llmstxt.org): `llms.txt`, `llms-full.txt`,
 * `llms-small.txt`, a `.md` copy of every page and of every agent guide topic. The docs build writes them through the
 * integration in `astro.config.mjs`; everything here runs under Node and Bun alike.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTopics, type AgentTopic } from "../../packages/cli/src/agents/topics.ts";

/** The pages folder of the docs site. */
export const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/content/docs");

/** One docs page, converted to plain Markdown. */
export interface DocsPage {
  /** Its file inside the content folder, like `guides/queues.md`. */
  file: string;
  /** Its site path, like `/guides/queues/` (`/` for the home page). */
  path: string;
  /** Where its Markdown copy is served, like `/guides/queues.md` (`/index.md` for the home page). */
  markdownPath: string;
  title: string;
  description: string;
  /** `sidebar.order` from the frontmatter. */
  order?: number;
  /** The page body as plain Markdown, without the frontmatter. */
  markdown: string;
}

/** The sidebar groups of the site, by folder, in order. */
export const SIDEBAR_GROUPS = ["getting-started", "tutorial", "guides", "reference", "recipes"] as const;

const FENCE = /^\s*(```|~~~)/;
const ADMONITION_TITLES: Record<string, string> = { note: "Note", tip: "Tip", caution: "Caution", danger: "Danger" };

/** A frontmatter scalar: double-quoted values are JSON strings, single-quoted ones YAML strings. */
function scalar(value: string): string {
  const text = value.trim();
  if (text.startsWith('"')) return JSON.parse(text) as string;
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

/** Splits a page into its frontmatter fields (title, description, sidebar order) and its body. */
export function splitFrontmatter(source: string): { title: string; description: string; order?: number; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { title: "", description: "", body: source };
  const lines = match[1]!.split("\n");
  const field = (name: string) => {
    const line = lines.find((candidate) => candidate.startsWith(`${name}:`));
    return line === undefined ? "" : scalar(line.slice(name.length + 1));
  };
  const orderLine = lines.findIndex((line) => line === "sidebar:");
  const order = orderLine < 0 ? undefined : lines.slice(orderLine + 1).find((line) => /^\s+order:/.test(line));
  const parsed = order === undefined ? undefined : Number(order.split(":")[1]!.trim().replaceAll("_", ""));
  return { title: field("title"), description: field("description"), ...(parsed === undefined ? {} : { order: parsed }), body: source.slice(match[0].length) };
}

/**
 * Converts the body of a Markdown or MDX page to plain Markdown: import lines and comments are removed, admonitions
 * (`:::note`) become blockquotes, components are reduced to their content (with a `title` attribute as a bold line),
 * and the `check` marker of code fences is dropped. Code blocks are left as they are.
 */
export function toPlainMarkdown(body: string): string {
  const out: string[] = [];
  let fenced = false;
  let quote: string | undefined;
  const push = (line: string) => out.push(quote === undefined ? line : line === "" ? ">" : `> ${line}`);
  for (const raw of body.split("\n")) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      push(fenced ? raw.replace(/^(\s*(?:```|~~~)\w*)\s+check\b/, "$1") : raw);
      continue;
    }
    if (fenced) {
      push(raw);
      continue;
    }
    const admonition = /^:::(\w+)(?:\[(.*)\])?\s*$/.exec(raw);
    if (admonition) {
      quote = admonition[2] ?? ADMONITION_TITLES[admonition[1]!] ?? admonition[1]!;
      out.push(`> **${quote}:**`, ">");
      continue;
    }
    if (quote !== undefined && /^:::\s*$/.test(raw)) {
      while (out.at(-1) === ">") out.pop();
      quote = undefined;
      continue;
    }
    if (/^import\s.+\sfrom\s+["'][^"']+["'];?\s*$/.test(raw) || /^import\s+["'][^"']+["'];?\s*$/.test(raw)) continue;
    if (/^\s*\{\/\*.*\*\/\}\s*$/.test(raw) || /^\s*<!--.*-->\s*$/.test(raw)) continue;
    const opening = /^\s*<([A-Z][A-Za-z0-9.]*)((?:\s[^>]*)?)\/?>\s*$/.exec(raw);
    if (opening) {
      const title = /\btitle="([^"]*)"/.exec(opening[2] ?? "")?.[1];
      if (title) push(`**${title}**`);
      continue;
    }
    if (/^\s*<\/[A-Z][A-Za-z0-9.]*>\s*$/.test(raw)) {
      if (out.at(-1) !== "") push("");
      continue;
    }
    push(raw.replace(/^ {2,}(?=\S)/, ""));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The site path of a page file: `guides/queues.md` is `/guides/queues/`, `guides/index.md` is `/guides/`. */
export function pagePath(file: string): string {
  const slug = file.replace(/\.(md|mdx)$/, "").replace(/(^|\/)index$/, "");
  return slug === "" ? "/" : `/${slug}/`;
}

/** Where the Markdown copy of a page is served: its path without the trailing slash, plus `.md`. */
export const markdownPathOf = (path: string) => (path === "/" ? "/index.md" : `${path.replace(/\/$/, "")}.md`);

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return filesUnder(full, `${prefix}${entry}/`);
      return /\.(md|mdx)$/.test(entry) ? [`${prefix}${entry}`] : [];
    });
}

/** Reads one page. */
export function readPage(file: string, contentDir: string = CONTENT_DIR): DocsPage {
  const { title, description, order, body } = splitFrontmatter(readFileSync(join(contentDir, file), "utf8"));
  const path = pagePath(file);
  return { file, path, markdownPath: markdownPathOf(path), title, description, ...(order === undefined ? {} : { order }), markdown: toPlainMarkdown(body) };
}

/** The sort key of a page or folder in the sidebar: its order, then its slug (a folder's index page sorts as the folder). */
const slugOf = (path: string) => path.replace(/^\/|\/$/g, "");

/** The entries of one folder in sidebar order: pages and subfolders, sorted by `sidebar.order` and then by slug. */
function sidebarEntries(pages: readonly DocsPage[], folder: string): DocsPage[] {
  const inside = pages.filter((page) => page.file.startsWith(`${folder}/`));
  const direct = inside.filter((page) => !page.file.slice(folder.length + 1).includes("/"));
  const subfolders = [...new Set(inside.filter((page) => !direct.includes(page)).map((page) => `${folder}/${page.file.slice(folder.length + 1).split("/")[0]}`))];
  type Entry = { order?: number; slug: string; pages: DocsPage[] };
  const entries: Entry[] = [
    ...direct.map((page) => ({ ...(page.order === undefined ? {} : { order: page.order }), slug: slugOf(page.path), pages: [page] })),
    ...subfolders.map((sub) => ({ slug: sub, pages: sidebarEntries(pages, sub) })),
  ];
  entries.sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order;
    if (a.order !== undefined && b.order === undefined) return -1;
    if (a.order === undefined && b.order !== undefined) return 1;
    return a.slug.localeCompare(b.slug);
  });
  return entries.flatMap((entry) => entry.pages);
}

/** Every page of the site: the home page, then each sidebar group in its sidebar order. */
export function readPages(contentDir: string = CONTENT_DIR): DocsPage[] {
  const pages = filesUnder(contentDir).map((file) => readPage(file, contentDir));
  const home = pages.filter((page) => page.path === "/");
  return [...home, ...SIDEBAR_GROUPS.flatMap((group) => sidebarEntries(pages, group))];
}

/** Where an agent guide topic is served. */
export const topicPath = (topic: AgentTopic) => `/agents/${topic.name}.md`;

/** The Markdown copy of an agent topic, with its site links pointing to the Markdown copies of the pages. */
export const topicMarkdown = (topic: AgentTopic) => `${markdownLinks(topic.markdown).trim()}\n`;

/** Points the site links of a text (`](/guides/queues/#retries)`) to the Markdown copies of the pages. */
export const markdownLinks = (markdown: string) =>
  markdown.replace(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g, (_, path: string, anchor = "") => `](${markdownPathOf(path.endsWith("/") ? path : `${path}/`)}${anchor})`);

/** The Markdown copy of a page: its title, its description and its body. */
export function pageMarkdown(page: DocsPage): string {
  return [`# ${page.title}`, "", ...(page.description ? [`> ${page.description}`, ""] : []), page.markdown, ""].join("\n");
}

const SUMMARY =
  "QuickService.ts builds REST services on Bun from TypeScript types: each entity type in `entities/` becomes CRUD routes, validation, filters, relations, migrations, typed repositories and an OpenAPI document, on an in-memory, SQLite, PostgreSQL or MongoDB database.";

const WHEN_TO_USE =
  "Use it for record-centric backends and internal APIs written in TypeScript on Bun, when you want CRUD, validation, paging, filtering, relations, migrations and API docs generated, and built-in features (security, queues, events, history, idempotency, ETags, feature flags, health routes) switched on with one config key. It is not for Node.js-only runtimes or GraphQL-only APIs. Projects are created with `bunx quickservicets init <name> --db <database>`; start with the agent guides below.";

const entry = (title: string, url: string, description: string) => `- [${title}](${url})${description ? `: ${description}` : ""}`;

/** The section of `llms.txt` a page is listed in: the home page and the tutorial with Getting started. */
function sectionOf(page: DocsPage): string {
  const group = page.file.split("/")[0]!;
  if (group === "guides") return "Guides";
  if (group === "reference") return "Reference";
  if (group === "recipes") return "Recipes";
  return "Getting started";
}

/** `llms.txt`: the title, a summary, when to use it, then the agent guides and every page with its description. */
export function llmsTxt(topics: readonly AgentTopic[] = readTopics(), pages: readonly DocsPage[] = readPages()): string {
  const sections = ["Getting started", "Guides", "Reference", "Recipes"];
  return [
    "# QuickService.ts",
    "",
    `> ${SUMMARY}`,
    "",
    WHEN_TO_USE,
    "",
    "The full documentation in one file is at /llms-full.txt, and a smaller set (agent guides, getting started, the CLI, config and tags reference) at /llms-small.txt.",
    "",
    "## Agent guides",
    "",
    ...topics.map((topic) => entry(topic.title, topicPath(topic), topic.summary)),
    ...sections.flatMap((section) => ["", `## ${section}`, "", ...pages.filter((page) => sectionOf(page) === section).map((page) => entry(page.title, page.markdownPath, page.description))]),
    "",
  ].join("\n");
}

/** One document of the combined files: `# <Title>`, its URL, then its Markdown. */
function combined(title: string, url: string, markdown: string): string {
  return [`# ${title}`, "", `URL: ${url}`, "", markdown.trim(), ""].join("\n");
}

const topicBody = (topic: AgentTopic) => markdownLinks(topic.markdown.split("\n").slice(1).join("\n"));

const pageBody = (page: DocsPage) => [...(page.description ? [`> ${page.description}`, ""] : []), page.markdown].join("\n");

/** `llms-full.txt`: the agent topics, then every page in sidebar order. */
export function llmsFull(topics: readonly AgentTopic[] = readTopics(), pages: readonly DocsPage[] = readPages()): string {
  return [...topics.map((topic) => combined(topic.title, topicPath(topic), topicBody(topic))), ...pages.map((page) => combined(page.title, page.markdownPath, pageBody(page)))].join("\n");
}

/** The reference pages `llms-small.txt` keeps besides getting started. */
export const SMALL_REFERENCE = ["reference/cli.mdx", "reference/config.mdx", "reference/tags.mdx"];

/** `llms-small.txt`: the agent topics, the getting started pages and the CLI, config and tags reference. */
export function llmsSmall(topics: readonly AgentTopic[] = readTopics(), pages: readonly DocsPage[] = readPages()): string {
  const kept = pages.filter((page) => page.file.startsWith("getting-started/") || SMALL_REFERENCE.includes(page.file));
  return [...topics.map((topic) => combined(topic.title, topicPath(topic), topicBody(topic))), ...kept.map((page) => combined(page.title, page.markdownPath, pageBody(page)))].join("\n");
}

/** Every file the docs build adds to the site root, keyed by its path in the built site. */
export function llmsFiles(topics: readonly AgentTopic[] = readTopics(), pages: readonly DocsPage[] = readPages()): Record<string, string> {
  return {
    "llms.txt": llmsTxt(topics, pages),
    "llms-full.txt": llmsFull(topics, pages),
    "llms-small.txt": llmsSmall(topics, pages),
    ...Object.fromEntries(topics.map((topic) => [topicPath(topic).slice(1), topicMarkdown(topic)])),
    ...Object.fromEntries(pages.map((page) => [page.markdownPath.slice(1), pageMarkdown(page)])),
  };
}

/** Problems of `llms-full.txt`: `import ` lines or unrendered component tags outside code blocks, as `<line>: <text>`. */
export function unrenderedLines(markdown: string): string[] {
  let fenced = false;
  return markdown.split("\n").flatMap((line, index) => {
    const text = line.replace(/^(> ?)+/, "");
    if (FENCE.test(text)) {
      fenced = !fenced;
      return [];
    }
    if (fenced) return [];
    const prose = text.replace(/`[^`]*`/g, "");
    return /^import\s/.test(prose) || /<\/?[A-Z][A-Za-z0-9.]*[\s/>]/.test(prose) ? [`${index + 1}: ${line}`] : [];
  });
}
