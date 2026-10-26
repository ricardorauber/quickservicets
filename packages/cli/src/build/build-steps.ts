import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CORE_VERSION, generatedPath, type BuildFolderFile, type EntityModel, type FeatureBuildContext, type ResolvedConfig } from "@quickservicets/core";
import { BuildError } from "../errors.ts";
import type { FolderFile } from "./feature-files.ts";

/** The outcome of one feature's build step. */
export interface BuildStepResult {
  key: string;
  /** How long the step took, in milliseconds. */
  ms: number;
  /** True when every `ctx.cached` call of the step found its inputs unchanged. */
  upToDate: boolean;
  /** The lines the step printed with `ctx.log`. */
  lines: string[];
}

/** The file the cache hash of a feature's build step is stored in, inside its output folder. */
export const BUILD_HASH_FILE = ".build-hash";

/** Every file under a path, sorted, with its path relative to the project root. */
function inputFiles(root: string, input: string): string[] {
  const full = resolve(root, input);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** The hash of the inputs' content, the feature's options and the core version. */
export function buildHash(root: string, inputs: readonly string[], options: unknown): string {
  const hash = createHash("sha256");
  hash.update(`core ${CORE_VERSION}\n`);
  hash.update(`options ${JSON.stringify(options)}\n`);
  for (const input of [...inputs].sort()) {
    const files = inputFiles(root, input);
    if (files.length === 0) hash.update(`missing ${input}\n`);
    for (const file of files) {
      hash.update(`file ${relative(root, file).split(sep).join("/")}\n`);
      hash.update(readFileSync(file));
    }
  }
  return hash.digest("hex");
}

export interface BuildStepsOptions {
  root: string;
  generatedDir: string;
  config: ResolvedConfig;
  models: readonly EntityModel[];
  /** The files of the features' convention folders. */
  folderFiles: readonly FolderFile[];
  /** Runs only these features' steps (default: every enabled feature's). */
  only?: readonly string[];
}

/**
 * Runs each enabled feature's `build` step in feature order, in its own `.generated/<key>/` folder; fails with
 * `<key>: build: <message>`.
 */
export async function runBuildSteps({ root, generatedDir, config, models, folderFiles, only }: BuildStepsOptions): Promise<BuildStepResult[]> {
  const results: BuildStepResult[] = [];
  for (const feature of config.features) {
    const step = feature.definition.build;
    if (!step || (only && !only.includes(feature.key))) continue;
    const outDir = join(generatedDir, feature.key);
    mkdirSync(outDir, { recursive: true });
    const lines: string[] = [];
    let calls = 0;
    let skipped = 0;
    const folders: Record<string, BuildFolderFile[]> = {};
    for (const file of folderFiles.filter((entry) => entry.feature === feature.key)) (folders[file.folder] ??= []).push({ name: file.name, path: file.source });
    const path = (relativePath: string) => generatedPath(outDir, relativePath, feature.key);
    const context: FeatureBuildContext = {
      root,
      outDir,
      models,
      options: feature.options,
      folders,
      production: config.production,
      log: (line) => void lines.push(line),
      async cached(inputs, fn) {
        calls++;
        const hash = buildHash(root, inputs, feature.options);
        const file = join(outDir, BUILD_HASH_FILE);
        if (existsSync(file) && readFileSync(file, "utf8") === hash) {
          skipped++;
          return false;
        }
        await fn();
        writeFileSync(file, hash);
        return true;
      },
      path,
      async write(relativePath, content) {
        const file = path(relativePath);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      },
    };
    const startedAt = performance.now();
    try {
      await step(context as never);
    } catch (error) {
      throw new BuildError(`${feature.key}: build: ${error instanceof Error ? error.message : String(error)}`);
    }
    results.push({ key: feature.key, ms: Math.round(performance.now() - startedAt), upToDate: calls > 0 && skipped === calls, lines });
  }
  return results;
}

/** The lines the CLI prints for the build steps. */
export function buildStepLines(results: readonly BuildStepResult[]): string[] {
  return results.flatMap((result) => [...result.lines.map((line) => `${result.key}: ${line}`), result.upToDate ? `${result.key} is up to date` : `Built ${result.key} in ${result.ms} ms`]);
}
