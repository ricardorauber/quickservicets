import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

export const SECOND_LOCALE = "pt-br";

function pagesUnder(dir: string, skip?: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === skip ? [] : pagesUnder(path).map((page) => `${entry}/${page}`);
    return /\.(md|mdx)$/.test(entry) ? [entry] : [];
  });
}

/** Pages that exist in one locale but not the other, as paths relative to the content folder. */
export function missingTranslations(contentDir: string): string[] {
  const english = pagesUnder(contentDir, SECOND_LOCALE);
  const portuguese = pagesUnder(join(contentDir, SECOND_LOCALE));
  return [
    ...english.filter((page) => !portuguese.includes(page)).map((page) => `${SECOND_LOCALE}/${page}`),
    ...portuguese.filter((page) => !english.includes(page)),
  ];
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
  return [...pagesUnder(contentDir)].flatMap((page) => extractSnippets(page, readFileSync(join(contentDir, page), "utf8")));
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
