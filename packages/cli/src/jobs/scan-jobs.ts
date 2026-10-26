import { isJobDefinition, type JobOptions, type JobSchedule } from "@quickservicets/core";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BuildError } from "../errors.ts";
import { jobOptionsError, scheduleError } from "./validate-job.ts";

export interface JobEntry {
  /** The path under `jobs/` without extension, e.g. `billing/close-invoices`. */
  name: string;
  /** File path relative to the project root, or `@quickservicets/core/features/...` for a native's file. */
  file: string;
  /** Absolute path of the file (default: the file under the project root). */
  source?: string;
  /** The key of the feature whose folder holds the file. */
  feature?: string;
  schedule: JobSchedule;
  options: JobOptions;
}

const TEST_FILE = /\.(test|spec)\.ts$/;

/** The `.ts` files under `jobs/`, subfolders included and test files excluded, relative to the project root. */
export function listJobFiles(projectRoot: string): string[] {
  return listJobFolder(join(projectRoot, "jobs")).map((file) => relative(projectRoot, file));
}

/** The absolute paths of the job files under a folder, subfolders included and test files excluded. */
export function listJobFolder(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !TEST_FILE.test(entry)) files.push(full);
    }
  };
  walk(root);
  return files;
}

/** The job name of a file: its path under `jobs/` without extension, with `/` separators. */
export function jobNameOf(file: string): string {
  return file.split(/[\\/]/).slice(1).join("/").slice(0, -".ts".length);
}

/** Imports and validates every job of the project. */
export async function scanJobs(projectRoot: string): Promise<JobEntry[]> {
  const jobs = await scanJobFolder(join(projectRoot, "jobs"), (file) => relative(projectRoot, file));
  return jobs.map(({ source: _source, ...entry }) => entry);
}

/**
 * Imports and validates the jobs of one folder; each is named by its path in the folder without extension, after
 * `prefix` (`history/` for the jobs of the `history` feature).
 */
export async function scanJobFolder(root: string, nameOf: (file: string) => string, prefix = ""): Promise<JobEntry[]> {
  const jobs: JobEntry[] = [];
  for (const source of listJobFolder(root)) {
    const file = nameOf(source);
    const module = (await import(source)) as { default?: unknown };
    const definition = module.default;
    if (!isJobDefinition(definition)) throw new BuildError(`${file}: must default-export job(...)`);
    const error = scheduleError(definition.schedule) ?? jobOptionsError(definition.options);
    if (error) throw new BuildError(`${file}: ${error}`);
    const name = `${prefix}${relative(root, source).split(sep).join("/").slice(0, -".ts".length)}`;
    jobs.push({ name, file, source, schedule: definition.schedule, options: definition.options });
  }
  return jobs;
}
