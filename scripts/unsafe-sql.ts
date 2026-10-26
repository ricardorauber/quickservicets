/**
 * Finds `unsafe()` calls that receive SQL text built at runtime, outside the database adapters. Run by
 * `bun run typecheck`; a call that must pass built text says why with `// quickservicets-allow-unsafe: <reason>` on the
 * line above it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");

/** Files below this folder build SQL from validated identifiers and are not checked. */
export const EXEMPT_FOLDER = "packages/core/src/adapters/";
const MARKER = /^\/\/\s*quickservicets-allow-unsafe:(.*)$/;

/** A finding, printed as `<file>:<line>: <message>`. */
export interface UnsafeSqlProblem {
  file: string;
  line: number;
  message: string;
}

export const formatProblem = (problem: UnsafeSqlProblem): string => `${problem.file}:${problem.line}: ${problem.message}`;

const isLiteralSql = (node: ts.Expression): boolean => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

function calleeIsUnsafe(callee: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "unsafe";
  if (ts.isElementAccessExpression(callee)) {
    const argument = callee.argumentExpression;
    return (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && argument.text === "unsafe";
  }
  return false;
}

/** Checks one file's source; `file` is the path printed in each problem, relative to the repository root. */
export function findUnsafeSql(file: string, source: string): UnsafeSqlProblem[] {
  if (file.split(sep).join("/").startsWith(EXEMPT_FOLDER)) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const markers = new Map<number, string>();
  const seen = new Set<number>();
  const collectComments = (position: number) => {
    for (const range of [...(ts.getLeadingCommentRanges(source, position) ?? []), ...(ts.getTrailingCommentRanges(source, position) ?? [])]) {
      if (seen.has(range.pos) || range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      seen.add(range.pos);
      const match = MARKER.exec(source.slice(range.pos, range.end));
      if (match) markers.set(lineOf(range.pos), match[1]!.trim());
    }
  };
  const calls: number[] = [];
  const visit = (node: ts.Node) => {
    collectComments(node.pos);
    collectComments(node.end);
    if (ts.isCallExpression(node) && calleeIsUnsafe(node.expression)) {
      const first = node.arguments[0];
      if (!first || !isLiteralSql(first)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name : (callee as ts.ElementAccessExpression).argumentExpression;
        calls.push(lineOf(name.getStart(sourceFile)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  collectComments(sourceFile.endOfFileToken.pos);

  const problems: UnsafeSqlProblem[] = [];
  for (const [line, reason] of markers) {
    if (reason === "") problems.push({ file, line, message: "quickservicets-allow-unsafe needs a reason" });
  }
  for (const line of calls) {
    if (markers.get(line - 1)) continue;
    problems.push({ file, line, message: "unsafe() must receive literal SQL; pass values as parameters" });
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** The folders checked, relative to the repository root. */
export function checkedFolders(repositoryRoot = root): string[] {
  const packages = readdirSync(join(repositoryRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`);
  return [...packages.sort(), "examples", "benchmarks/quickservicets", "docs/scripts"];
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

/** Checks every TypeScript source of the checked folders. */
export function checkUnsafeSql(repositoryRoot = root): UnsafeSqlProblem[] {
  const problems: UnsafeSqlProblem[] = [];
  for (const folder of checkedFolders(repositoryRoot)) {
    for (const path of sourceFiles(join(repositoryRoot, folder)).sort()) {
      problems.push(...findUnsafeSql(relative(repositoryRoot, path).split(sep).join("/"), readFileSync(path, "utf8")));
    }
  }
  return problems;
}
