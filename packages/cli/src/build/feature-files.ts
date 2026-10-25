import { featureDir, type ResolvedFeature } from "@quickservice/core";
import { resolve } from "node:path";
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
