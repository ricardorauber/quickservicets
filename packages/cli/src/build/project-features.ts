import { FEATURES_DIR } from "@quickservice/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { BuildError } from "../errors.ts";

/** The framework entries project features may import. */
export const FEATURE_IMPORTS = ["@quickservice/core", "@quickservice/core/testing"];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Fails the build naming the file when a file under `features/` imports a path inside `@quickservice/core` other than
 * its public entries, so project features keep working when the core's internals change.
 */
export function assertFeatureImports(projectRoot: string): void {
  const problems: string[] = [];
  for (const file of sourceFiles(join(projectRoot, FEATURES_DIR)).sort()) {
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith("@quickservice/core/") || FEATURE_IMPORTS.includes(fileName)) continue;
      const name = relative(projectRoot, file).split(sep).join("/");
      problems.push(`${name}: imports ${fileName}; project features import the framework only from ${FEATURE_IMPORTS.join(" or ")}`);
    }
  }
  if (problems.length > 0) throw new BuildError(problems.join("\n"));
}

const identifierOf = (key: string, index: number) => `feature${index}_${key.replace(/[^A-Za-z0-9_$]/g, "_")}`;

/** One file of a feature's convention folder, as the generated registry imports it. */
export interface RegistryFile {
  feature: string;
  folder: string;
  name: string;
  /** The import specifier, relative to `.generated/` or through the core package. */
  specifier: string;
}

/**
 * `.generated/features.ts`: every project feature, imported by a project-relative path, and `featureFolders`, the
 * default exports of the features' convention folders by feature key, folder name and file name.
 */
export function generateFeaturesFile(header: string, keys: readonly string[], folderFiles: readonly RegistryFile[] = []): string {
  const registry = new Map<string, Map<string, string[]>>();
  folderFiles.forEach((entry, index) => {
    const folders = registry.get(entry.feature) ?? new Map<string, string[]>();
    registry.set(entry.feature, folders);
    folders.set(entry.folder, [...(folders.get(entry.folder) ?? []), `[${JSON.stringify(entry.name)}, folder${index}]`]);
  });
  const registryLines = [...registry].flatMap(([feature, folders]) => [
    `  ${JSON.stringify(feature)}: {`,
    ...[...folders].map(([folder, entries]) => `    ${JSON.stringify(folder)}: new Map<string, unknown>([${entries.join(", ")}]),`),
    "  },",
  ]);
  return [
    header,
    'import type { FeatureFolderRegistry, ProjectFeatureModule } from "@quickservice/core";',
    ...keys.map((key, index) => `import ${identifierOf(key, index)} from "../${FEATURES_DIR}/${key}/index.ts";`),
    ...folderFiles.map((entry, index) => `import folder${index} from ${JSON.stringify(entry.specifier)};`),
    "",
    "/** The project's features, registered by the server before it resolves the config. */",
    `export const features: ProjectFeatureModule[] = [${keys.map((key, index) => `{ folder: ${JSON.stringify(key)}, definition: ${identifierOf(key, index)} }`).join(", ")}];`,
    "",
    "/** The default exports of the features' convention folders, by feature key, folder name and file name. */",
    registryLines.length > 0 ? `export const featureFolders: FeatureFolderRegistry = {\n${registryLines.join("\n")}\n};` : "export const featureFolders: FeatureFolderRegistry = {};",
    "",
  ].join("\n");
}

/** Lines added to `.generated/types.ts` so each project feature's config key is typed with its options. */
export function featureTypeLines(keys: readonly string[]): string[] {
  if (keys.length === 0) return [];
  return [
    'import type { FeatureConfig } from "@quickservice/core";',
    ...keys.map((key, index) => `import type ${identifierOf(key, index)} from "../${FEATURES_DIR}/${key}/index.ts";`),
    "",
    'declare module "@quickservice/core" {',
    "  interface NativeFeatures {",
    ...keys.map((key, index) => `    ${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}?: FeatureConfig<typeof ${identifierOf(key, index)}>;`),
    "  }",
    "}",
    "",
  ];
}

/** The line the build prints for a project feature that replaces a native. */
export const overrideLine = (key: string) => `Override: ${FEATURES_DIR}/${key} replaces the ${key} native`;
