import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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
}

/** Code blocks fenced as ```ts check (other words after `check`, like a title, are allowed). */
export function extractSnippets(page: string, markdown: string): Snippet[] {
  const snippets: Snippet[] = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*```ts\s+check\b/.test(lines[index]!)) continue;
    const start = index;
    const body: string[] = [];
    for (index++; index < lines.length && !/^\s*```\s*$/.test(lines[index]!); index++) body.push(lines[index]!);
    snippets.push({ page, line: start + 1, code: body.join("\n") });
  }
  return snippets;
}

export function snippetsOf(contentDir: string): Snippet[] {
  return [...pagesUnder(contentDir)].flatMap((page) => extractSnippets(page, readFileSync(join(contentDir, page), "utf8")));
}

/** Type-checks snippets against the framework packages; returns `page:line: message` for each failure. */
export function snippetErrors(snippets: Snippet[], workDir: string): string[] {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const files = snippets.map((snippet, index) => {
    const file = join(workDir, `snippet-${index}.ts`);
    // Each snippet is its own module, so names never clash between snippets.
    writeFileSync(file, `${snippet.code}\nexport {};\n`);
    return file;
  });
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    types: ["bun"],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  return files.flatMap((file, index) => {
    const source = program.getSourceFile(file);
    const snippet = snippets[index]!;
    return ts.getPreEmitDiagnostics(program, source).map((diagnostic) => {
      const line = diagnostic.start !== undefined && source ? source.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 0;
      return `${snippet.page}:${snippet.line + line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    });
  });
}

export const relativeTo = (root: string, path: string) => relative(root, path);
