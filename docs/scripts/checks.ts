import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

/** Every Markdown and MDX page under a folder, as sorted paths relative to it. */
export function pagesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return pagesUnder(path).map((page) => `${entry}/${page}`);
    return /\.(md|mdx)$/.test(entry) ? [entry] : [];
  });
}

export interface Snippet {
  page: string;
  /** 1-based line of the opening fence. */
  line: number;
  code: string;
  /** File path from the fence's `title="..."`; snippets of one page with titles form a small project. */
  title?: string;
}

/** Code blocks fenced as ```ts check (other words after `check`, like a title, are allowed). */
export function extractSnippets(page: string, markdown: string): Snippet[] {
  const snippets: Snippet[] = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const fence = /^\s*```ts\s+check\b(.*)$/.exec(lines[index]!);
    if (!fence) continue;
    const start = index;
    const title = /title="([^"]+)"/.exec(fence[1]!)?.[1];
    const body: string[] = [];
    for (index++; index < lines.length && !/^\s*```\s*$/.test(lines[index]!); index++) body.push(lines[index]!);
    snippets.push({ page, line: start + 1, code: body.join("\n"), ...(title ? { title } : {}) });
  }
  return snippets;
}

export function snippetsOf(contentDir: string): Snippet[] {
  return pagesUnder(contentDir).flatMap((page) => extractSnippets(page, readFileSync(join(contentDir, page), "utf8")));
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
  types: ["bun"],
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
};

/**
 * Type-checks snippets against the framework packages, one program per page so pages never see each other's
 * declarations; returns `page:line: message` for each failure.
 */
export function snippetErrors(snippets: Snippet[], workDir: string): string[] {
  rmSync(workDir, { recursive: true, force: true });
  const pages = [...new Set(snippets.map((snippet) => snippet.page))];
  let previous: ts.Program | undefined;
  return pages.flatMap((page, pageIndex) => {
    const dir = join(workDir, `page-${pageIndex}`);
    const ofPage = snippets.filter((snippet) => snippet.page === page);
    const files = ofPage.map((snippet, index) => {
      const file = join(dir, snippet.title ?? `snippet-${index}.ts`);
      mkdirSync(dirname(file), { recursive: true });
      // Untitled snippets are their own modules, so names never clash between them.
      writeFileSync(file, snippet.title ? snippet.code : `${snippet.code}\nexport {};\n`);
      return file;
    });
    const program = ts.createProgram(files, COMPILER_OPTIONS, undefined, previous);
    previous = program;
    return files.flatMap((file, index) => {
      const source = program.getSourceFile(file);
      const snippet = ofPage[index]!;
      return ts.getPreEmitDiagnostics(program, source).map((diagnostic) => {
        const line = diagnostic.start !== undefined && source ? source.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 0;
        return `${snippet.page}:${snippet.line + line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
      });
    });
  });
}

export const relativeTo = (root: string, path: string) => relative(root, path);

/** The heading of the installation page's section that keeps every instruction that needs a clone of the repository. */
export const CLONE_SECTION = "Working from a clone";

const REPOSITORY_ONLY: [RegExp, string][] = [
  [/packages\/cli\/src\/index\.ts/, "packages/cli/src/index.ts"],
  [/not on npm/i, "not on npm"],
  [/\binit\s+(\.\/)?examples\//, "a project created under examples/"],
];

/**
 * The repository-only instructions a page mentions outside its "Working from a clone" section (which runs up to the
 * next heading of the same or a higher level), as `<line>: <what>`.
 */
export function repositoryOnlyMentions(markdown: string): string[] {
  const problems: string[] = [];
  let cloneLevel: number | undefined;
  let fenced = false;
  markdown.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (cloneLevel !== undefined && level <= cloneLevel) cloneLevel = undefined;
      if (heading[2]!.trim() === CLONE_SECTION) cloneLevel = level;
    }
    if (cloneLevel !== undefined) return;
    for (const [pattern, what] of REPOSITORY_ONLY) if (pattern.test(line)) problems.push(`${index + 1}: ${what}`);
  });
  return problems;
}

/**
 * The `curl` commands of a page whose URL has square brackets (like `where[role][eq]`) but no `-g`, as `<line>: <command>`;
 * without `-g`, curl reads the brackets as a URL pattern and fails before sending the request.
 */
export function globbedCurlCommands(markdown: string): string[] {
  return markdown.split("\n").flatMap((line, index) => {
    const command = /\bcurl\s(.*)/.exec(line)?.[1];
    if (command === undefined || !/\?\S*\[/.test(command) || /(^|\s)-[A-Za-z]*g/.test(command)) return [];
    return [`${index + 1}: ${line.trim()}`];
  });
}

/**
 * Phrases of the time when `init` asked for a database, the config file was required and `File` and `Media` were in
 * every model; compared without backticks and case-insensitively.
 */
export const STALE_PHRASES = ["init would wait", "without it, init asks", "Config file not found", "includes the built-in File and Media"] as const;

/** The stale phrases a page or topic contains, as `<line>: <phrase>`. */
export function stalePhrases(markdown: string): string[] {
  return markdown.split("\n").flatMap((line, index) => {
    const plain = line.replaceAll("`", "").toLowerCase();
    return STALE_PHRASES.filter((phrase) => plain.includes(phrase.toLowerCase())).map((phrase) => `${index + 1}: ${phrase}`);
  });
}
