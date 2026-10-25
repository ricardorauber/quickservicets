import { featureDir, type ResolvedFeature } from "@quickservice/core";
import { join, relative, resolve, sep } from "node:path";
import { featureFileName } from "../entities/parse-entities.ts";
import { scanEndpointFolder, scanEndpoints, type EndpointRoute } from "../endpoints/scan-endpoints.ts";
import { BuildError } from "../errors.ts";
import { scanHookFolder, scanHooks, type HookEntry } from "../hooks/scan-hooks.ts";
import { listJobFiles, listJobFolder, scanJobFolder, scanJobs, type JobEntry } from "../jobs/scan-jobs.ts";

/** The absolute path of a contribution folder a feature declares, or undefined when it declares none. */
export function featureFolderOf(feature: ResolvedFeature, field: "endpoints" | "hooks" | "jobs", projectRoot: string): string | undefined {
  const folder = feature.definition[field];
  return folder === undefined ? undefined : resolve(featureDir(feature, projectRoot), folder);
}

/** The line the build prints when a project file replaces a feature's file. */
export const fileOverrideLine = (projectFile: string, featureFile: string, key: string) => `Override: ${projectFile} replaces ${featureFile} from ${key}`;

interface Named {
  file: string;
  feature?: string;
}

/**
 * Merges project entries with the features' entries of the same kind: a project entry replaces a feature's with the
 * same identity (printing an override line), and two features defining one identity fail naming both files.
 */
function merge<T extends Named>(project: T[], features: T[], identity: (entry: T) => string, what: (entry: T) => string, overrides: string[]): T[] {
  const projectByIdentity = new Map(project.map((entry) => [identity(entry), entry]));
  const owners = new Map<string, T>();
  const kept: T[] = [];
  for (const entry of features) {
    const id = identity(entry);
    const replacement = projectByIdentity.get(id);
    if (replacement) {
      overrides.push(fileOverrideLine(replacement.file, entry.file, entry.feature!));
      continue;
    }
    const previous = owners.get(id);
    if (previous) throw new BuildError(`${previous.file} and ${entry.file} both define ${what(entry)}`);
    owners.set(id, entry);
    kept.push(entry);
  }
  return [...project, ...kept];
}

export interface ProjectFiles {
  endpoints: EndpointRoute[];
  hooks: Map<string, HookEntry>;
  jobs: JobEntry[];
  /** `Override:` lines of project files replacing feature files. */
  overrides: string[];
  /** How many endpoints, hooks and jobs come from features. */
  fromFeatures: { endpoints: number; hooks: number; jobs: number };
}

/** The endpoints of the project and of its enabled features, merged by method and path. */
export function scanProjectEndpoints(projectRoot: string, features: readonly ResolvedFeature[], overrides: string[] = []): EndpointRoute[] {
  const fromFeatures = features.flatMap((feature) => {
    const folder = featureFolderOf(feature, "endpoints", projectRoot);
    if (!folder) return [];
    return scanEndpointFolder(folder, (file) => featureFileName(projectRoot, file)).map((route) => ({ ...route, feature: feature.key }));
  });
  return merge(scanEndpoints(projectRoot), fromFeatures, (route) => `${route.method} ${route.pattern}`, (route) => `${route.method} ${route.path}`, overrides);
}

/** The hooks of the project and of its enabled features, merged by name. */
export async function scanProjectHooks(projectRoot: string, features: readonly ResolvedFeature[], overrides: string[] = []): Promise<Map<string, HookEntry>> {
  const fromFeatures: HookEntry[] = [];
  for (const feature of features) {
    const folder = featureFolderOf(feature, "hooks", projectRoot);
    if (!folder) continue;
    for (const hook of (await scanHookFolder(folder, (file) => featureFileName(projectRoot, file))).values()) fromFeatures.push({ ...hook, feature: feature.key });
  }
  const merged = merge([...(await scanHooks(projectRoot)).values()], fromFeatures, (hook) => hook.name, (hook) => `the hook ${hook.name}`, overrides);
  return new Map(merged.map((hook) => [hook.name, hook]));
}

/** The jobs of the project and of its enabled features (named `<key>/<path>`), merged by name. */
export async function scanProjectJobs(projectRoot: string, features: readonly ResolvedFeature[], overrides: string[] = []): Promise<JobEntry[]> {
  const fromFeatures: JobEntry[] = [];
  for (const feature of features) {
    const folder = featureFolderOf(feature, "jobs", projectRoot);
    if (!folder) continue;
    const jobs = await scanJobFolder(folder, (file) => featureFileName(projectRoot, file), `${feature.key}/`);
    fromFeatures.push(...jobs.map((job) => ({ ...job, feature: feature.key })));
  }
  return merge(await scanJobs(projectRoot), fromFeatures, (job) => job.name, (job) => `the job ${job.name}`, overrides);
}

/** Every endpoint, hook and job of the project and of its enabled features. */
export async function scanProjectFiles(projectRoot: string, features: readonly ResolvedFeature[]): Promise<ProjectFiles> {
  const overrides: string[] = [];
  const hooks = await scanProjectHooks(projectRoot, features, overrides);
  const jobs = await scanProjectJobs(projectRoot, features, overrides);
  const endpoints = scanProjectEndpoints(projectRoot, features, overrides);
  const count = (entries: Iterable<Named>) => [...entries].filter((entry) => entry.feature).length;
  return { endpoints, hooks, jobs, overrides, fromFeatures: { endpoints: count(endpoints), hooks: count(hooks.values()), jobs: count(jobs) } };
}

/** Whether the project or one of its enabled features has job files. */
export function hasJobFiles(projectRoot: string, features: readonly ResolvedFeature[]): boolean {
  if (listJobFiles(projectRoot).length > 0) return true;
  return features.some((feature) => {
    const folder = featureFolderOf(feature, "jobs", projectRoot);
    return folder !== undefined && listJobFolder(folder).length > 0;
  });
}

/** One file of a feature's convention folder, from the project or from the feature's own folder. */
export interface FolderFile {
  /** The key of the feature that declares the folder. */
  feature: string;
  /** The folder's name in the feature definition. */
  folder: string;
  /** The file's path inside the folder, without extension. */
  name: string;
  /** How the build names the file: project-relative, or through the core package for a native. */
  file: string;
  /** Absolute path of the file. */
  source: string;
}

const TEST_FILE = /\.(test|spec)\.ts$/;

/** The `.ts` files under a folder, subfolders included, test and declaration files excluded, by name without extension. */
function folderFiles(root: string): { name: string; source: string }[] {
  return listJobFolder(root)
    .filter((file) => !TEST_FILE.test(file))
    .map((source) => ({ name: relative(root, source).split(sep).join("/").slice(0, -".ts".length), source }));
}

/**
 * The files of every convention folder the enabled features declare: the project's `<dir>/`, and the same folder inside
 * the declaring feature's folder and inside every other enabled feature's folder (a feature ships files for another
 * feature's folder, like a project feature's `events/` listeners). A project file replaces a feature's file of the
 * same name; two features shipping the same name fail. A folder with `featurePrefix` names a shipped file
 * `<key>/<path>`, after the key of the feature that ships it. Each file must default-export a value its folder's `check`
 * accepts.
 */
export async function scanFeatureFolders(projectRoot: string, features: readonly ResolvedFeature[], overrides: string[] = []): Promise<FolderFile[]> {
  const files: FolderFile[] = [];
  for (const feature of features) {
    for (const [folder, definition] of Object.entries(feature.definition.folders ?? {})) {
      const fromProject = folderFiles(join(projectRoot, definition.dir)).map(({ name, source }) => ({ feature: feature.key, folder, name, source, file: relative(projectRoot, source).split(sep).join("/") }));
      const projectNames = new Map(fromProject.map((entry) => [entry.name, entry]));
      const shipped = new Map<string, { entry: FolderFile; from: string }>();
      // The declaring feature first, then the others in feature order.
      for (const owner of [feature, ...features.filter((other) => other !== feature)]) {
        for (const { name: path, source } of folderFiles(resolve(featureDir(owner, projectRoot), definition.dir))) {
          const name = definition.featurePrefix ? `${owner.key}/${path}` : path;
          const file = featureFileName(projectRoot, source);
          const replacement = projectNames.get(name);
          if (replacement) {
            overrides.push(fileOverrideLine(replacement.file, file, owner.key));
            continue;
          }
          const taken = shipped.get(name);
          if (taken) throw new BuildError(`${definition.dir}/${name}.ts is shipped by both ${taken.from} and ${owner.key}`);
          shipped.set(name, { entry: { feature: feature.key, folder, name, source, file }, from: owner.key });
        }
      }
      const fromFeatures = [...shipped.values()].map(({ entry }) => entry);
      for (const entry of [...fromFeatures, ...fromProject].sort((a, b) => a.name.localeCompare(b.name))) {
        const module = (await import(entry.source)) as Record<string, unknown>;
        if (!Object.hasOwn(module, "default")) throw new BuildError(`${entry.file}: must have a default export`);
        const verdict = definition.check ? definition.check(module.default, entry.file) : true;
        if (verdict !== true) throw new BuildError(`${entry.file}: ${typeof verdict === "string" ? verdict : `rejected by the ${folder} folder of ${feature.key}`}`);
        files.push(entry);
      }
    }
  }
  return files;
}

/** The project paths `quickservice dev` watches for the enabled features: their folders and `watch` paths. */
export function featureWatchPaths(features: readonly ResolvedFeature[]): string[] {
  return [...new Set(features.flatMap((feature) => [...Object.values(feature.definition.folders ?? {}).map((folder) => folder.dir), ...(feature.definition.watch ?? [])]))];
}
