import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { FEATURES_DIR, loadConfig, NATIVE_FEATURES_DIR, registeredNatives, type ResolvedFeature } from "@quickservicets/core";
import { BuildError } from "../errors.ts";
import { importsOf, PUBLIC_ENTRY, resolvesTo, sourceFilesOf } from "./native-imports.ts";

export interface EjectOptions {
  /** One file of the native, relative to its folder, to copy instead of the whole native. */
  file?: string;
  /** Lists the files without writing them. */
  dryRun?: boolean;
  /** Overwrites files that exist. */
  force?: boolean;
}

/** One file an eject writes: where it goes in the project and its rewritten content. */
interface EjectedFile {
  /** Project-relative destination. */
  path: string;
  content: string;
}

const slash = (path: string) => path.split(sep).join("/");
const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest !== "" && !rest.startsWith("..") && !rest.startsWith(sep) ? slash(rest) : undefined;
};

/**
 * Rewrites a native file's imports for the project: `features/public.ts` becomes `@quickservicets/core`, and other files
 * of the native that are not copied are imported through `@quickservicets/core/features/<key>/<path>`.
 */
export function rewriteImports(source: string, file: string, nativeDir: string, key: string, copied: (path: string) => boolean): string {
  const publicEntry = join(NATIVE_FEATURES_DIR, PUBLIC_ENTRY);
  let result = source;
  for (const { specifier, pos, end } of importsOf(source).reverse()) {
    if (!specifier.startsWith(".")) continue;
    let replacement: string | undefined;
    if (resolvesTo(file, specifier, publicEntry)) replacement = "@quickservicets/core";
    else {
      const target = resolve(dirname(file), specifier);
      const path = inside(nativeDir, target);
      if (path !== undefined && !copied(path) && !copied(`${path}.ts`)) replacement = `@quickservicets/core/features/${key}/${path}`;
    }
    if (replacement !== undefined) result = `${result.slice(0, pos)}${replacement}${result.slice(end)}`;
  }
  return result;
}

/** The project path a native's contribution file is copied to, so it replaces the native's by the override rules. */
function destinationOf(feature: ResolvedFeature, path: string): string | undefined {
  const { definition } = feature;
  const folders: [string | undefined, (rest: string) => string][] = [
    [typeof definition.entities === "string" ? definition.entities : undefined, (rest) => `entities/${rest}`],
    [definition.endpoints, (rest) => `endpoints/${rest}`],
    [definition.hooks, (rest) => `hooks/${rest}`],
    [definition.jobs, (rest) => `jobs/${feature.key}/${rest}`],
    ...Object.values(definition.folders ?? {}).map((folder): [string, (rest: string) => string] => [folder.dir, (rest) => `${folder.dir}/${rest}`]),
  ];
  const nativeDir = join(NATIVE_FEATURES_DIR, feature.key);
  for (const [folder, place] of folders) {
    if (folder === undefined) continue;
    const rest = inside(resolve(nativeDir, folder), resolve(nativeDir, path));
    if (rest !== undefined) return place(rest);
  }
  return undefined;
}

/** The enabled native of a key, failing with the list of enabled native keys. */
async function enabledNative(cwd: string, key: string): Promise<ResolvedFeature> {
  const config = await loadConfig(cwd);
  // A native the project already replaces is still ejectable, so a second eject reports the existing folder.
  const natives = config.features.flatMap((feature) => {
    const native = registeredNatives().find((definition) => definition.key === feature.key);
    return native ? [{ ...feature, definition: native, native: true, project: false }] : [];
  });
  const feature = natives.find((entry) => entry.key === key);
  if (!feature) {
    const keys = natives.map((entry) => entry.key);
    throw new BuildError(`${key} is not an enabled native feature; enabled natives: ${keys.length > 0 ? keys.join(", ") : "none"}`);
  }
  return feature;
}

/** `quickservicets eject <key> [--file <path>] [--dry-run] [--force]`: the lines to print. */
export async function eject(cwd: string, key: string, options: EjectOptions = {}): Promise<string[]> {
  const feature = await enabledNative(cwd, key);
  const nativeDir = join(NATIVE_FEATURES_DIR, feature.key);
  const sources = sourceFilesOf(nativeDir).map((file) => ({ file, path: slash(relative(nativeDir, file)) }));
  let files: EjectedFile[];
  if (options.file !== undefined) {
    const path = slash(options.file).replace(/^\.\//, "");
    const source = sources.find((entry) => entry.path === path);
    const destination = source && destinationOf(feature, path);
    if (!source || !destination) throw new BuildError(`${path} is not a file of the entities, endpoints, hooks, jobs or folders of ${feature.key}`);
    files = [{ path: destination, content: rewriteImports(readFileSync(source.file, "utf8"), source.file, nativeDir, feature.key, (copied) => copied === path) }];
  } else {
    const all = new Set(sources.map((entry) => entry.path));
    files = sources.map((entry) => ({
      path: `${FEATURES_DIR}/${feature.key}/${entry.path}`,
      content: rewriteImports(readFileSync(entry.file, "utf8"), entry.file, nativeDir, feature.key, (copied) => all.has(copied)),
    }));
  }
  if (options.dryRun) return files.map((file) => `Would write ${file.path}`);
  if (!options.force) {
    const existing = options.file !== undefined ? files.find((file) => existsSync(join(cwd, file.path)))?.path : existsSync(join(cwd, FEATURES_DIR, feature.key)) ? `${FEATURES_DIR}/${feature.key}` : undefined;
    if (existing) throw new BuildError(`${existing} already exists; use --force to overwrite`);
  }
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file.path)), { recursive: true });
    writeFileSync(join(cwd, file.path), file.content);
  }
  if (options.file !== undefined) return [`Copied ${files[0]!.path}; it now replaces the one from ${feature.key}`];
  return [
    ...files.map((file) => `Wrote ${file.path}`),
    `${FEATURES_DIR}/${feature.key}/ now replaces the ${feature.key} native.`,
    `quickservicets.config.ts keeps ${feature.key}: {…} unchanged.`,
    `Delete ${FEATURES_DIR}/${feature.key}/ to go back to the native.`,
  ];
}
