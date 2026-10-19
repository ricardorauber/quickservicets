import { isJobDefinition, type JobOptions, type JobSchedule } from "@quickservice/core";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BuildError } from "../errors.ts";
import { jobOptionsError, scheduleError } from "./validate-job.ts";

export interface JobEntry {
  /** The path under `jobs/` without extension, e.g. `billing/close-invoices`. */
  name: string;
  /** File path relative to the project root. */
  file: string;
  schedule: JobSchedule;
  options: JobOptions;
}

const TEST_FILE = /\.(test|spec)\.ts$/;

/** The `.ts` files under `jobs/`, subfolders included and test files excluded, relative to the project root. */
export function listJobFiles(projectRoot: string): string[] {
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
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !TEST_FILE.test(entry)) files.push(relative(projectRoot, full));
    }
  };
  walk(join(projectRoot, "jobs"));
  return files;
}

/** The job name of a file: its path under `jobs/` without extension, with `/` separators. */
export function jobNameOf(file: string): string {
  return file.split(/[\\/]/).slice(1).join("/").slice(0, -".ts".length);
}

/** Imports and validates every job of the project. */
export async function scanJobs(projectRoot: string): Promise<JobEntry[]> {
  const jobs: JobEntry[] = [];
  for (const file of listJobFiles(projectRoot)) {
    const module = (await import(join(projectRoot, file))) as { default?: unknown };
    const definition = module.default;
    if (!isJobDefinition(definition)) throw new BuildError(`${file}: must default-export job(...)`);
    const error = scheduleError(definition.schedule) ?? jobOptionsError(definition.options);
    if (error) throw new BuildError(`${file}: ${error}`);
    jobs.push({ name: jobNameOf(file), file, schedule: definition.schedule, options: definition.options });
  }
  return jobs;
}
