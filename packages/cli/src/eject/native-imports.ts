import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { NATIVE_FEATURES_DIR } from "@quickservice/core";

/** The entry natives import the core from, relative to the folder of natives. */
export const PUBLIC_ENTRY = "public.ts";

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs)$/;

/** The source files of a folder, subfolders included. */
export function sourceFilesOf(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** The module specifiers a source file imports, with the range of each specifier's text (without quotes). */
export function importsOf(source: string): { specifier: string; pos: number; end: number }[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((file) => {
    const pos = source.indexOf(file.fileName, file.pos);
    return { specifier: file.fileName, pos, end: pos + file.fileName.length };
  });
}

/** Whether a relative specifier from `file` names `target`, with or without its extension. */
export function resolvesTo(file: string, specifier: string, target: string): boolean {
  const resolved = resolve(dirname(file), specifier);
  return resolved === target || `${resolved}.ts` === target;
}

/**
 * The imports of native features (`<dir>/<key>/**`) that reach the core other than through `<dir>/public.ts`: relative
 * paths outside the native's own folder and `@quickservice/core` specifiers. Each problem names the file and import.
 */
export function nativeImportProblems(dir: string = NATIVE_FEATURES_DIR): string[] {
  if (!existsSync(dir)) return [];
  const publicEntry = join(dir, PUBLIC_ENTRY);
  const problems: string[] = [];
  for (const native of readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const root = join(dir, native.name);
    for (const file of sourceFilesOf(root)) {
      const name = relative(dir, file).split(sep).join("/");
      for (const { specifier } of importsOf(readFileSync(file, "utf8"))) {
        if (specifier === "@quickservice/core" || specifier.startsWith("@quickservice/core/")) {
          problems.push(`${name}: imports ${specifier}; natives import the core only from ../${PUBLIC_ENTRY}`);
          continue;
        }
        if (!specifier.startsWith(".")) continue;
        if (resolvesTo(file, specifier, publicEntry)) continue;
        const inside = relative(root, resolve(dirname(file), specifier));
        if (inside.startsWith("..") || inside.startsWith(sep)) problems.push(`${name}: imports ${specifier}; natives import the core only from ../${PUBLIC_ENTRY}`);
      }
    }
  }
  return problems;
}
