import { isAbsolute, relative, resolve, sep } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import type { EntityModel } from "./model.ts";

/** The version of `@quickservicets/core`, part of every build step's cache hash. */
export const CORE_VERSION: string = packageJson.version;

/** One file of a feature's convention folder, as build steps see it. */
export interface BuildFolderFile {
  /** The file's path inside the folder, without extension. */
  name: string;
  /** The file's absolute path. */
  path: string;
}

/** What a feature's `build(ctx)` receives. */
export interface FeatureBuildContext<O = Record<string, unknown>> {
  /** The project's root folder. */
  root: string;
  /** The feature's output folder, `.generated/<key>/`; the step writes only here. */
  outDir: string;
  models: readonly EntityModel[];
  /** The feature's resolved options, environment overrides included. */
  options: O;
  /** The files of the feature's convention folders, by folder name. */
  folders: Readonly<Record<string, readonly BuildFolderFile[]>>;
  /** Whether the project builds for production. */
  production: boolean;
  /** Prints a line of the build output, after the feature's key. */
  log(line: string): void;
  /**
   * Runs `fn` only when the content of the given project files and folders, the feature's options or the core version
   * changed since the last run; returns whether it ran.
   */
  cached(inputs: readonly string[], fn: () => void | Promise<void>): Promise<boolean>;
  /** The absolute path of a file inside `outDir`, throwing for a path that leaves it. */
  path(relativePath: string): string;
  /** Writes a file inside `outDir`, creating its folders, throwing for a path that leaves it. */
  write(relativePath: string, content: string | Uint8Array): Promise<void>;
}

/**
 * The absolute path of `relativePath` inside a feature's generated folder; throws
 * `Path <path> leaves the generated folder of <key>` for absolute paths and `..` escapes.
 */
export function generatedPath(outDir: string, relativePath: string, key: string): string {
  const resolved = resolve(outDir, relativePath);
  const inside = relative(outDir, resolved);
  if (isAbsolute(relativePath) || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`Path ${relativePath} leaves the generated folder of ${key}`);
  }
  return resolved;
}
