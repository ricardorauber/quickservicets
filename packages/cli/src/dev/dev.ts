import { statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@quickservicets/core";
import { build, PENDING_MIGRATION_WARNING, type BuildOptions, type BuildSummary } from "../build/build.ts";
import { addAutomaticMigration, type CreatedMigration } from "../migrations/add.ts";
import { parseEnvFile, projectEnvironment } from "../env/env-check.ts";
import { existsSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { buildStepLines } from "../build/build-steps.ts";
import { debounce, realScheduler, type Scheduler } from "./debounce.ts";

export const DEBOUNCE_MS = 200;
export const WATCHED_PATHS = ["entities", "endpoints", "hooks", "jobs", "features", "quickservicets.config.ts", ".env", ".env.development", ".env.local"];

/** Every path `dev` watches: the project's own, then the enabled features' folders and `watch` paths from the last build. */
export function watchPaths(summary: Pick<BuildSummary, "watch"> | undefined): string[] {
  return [...new Set([...WATCHED_PATHS, ...(summary?.watch ?? [])])];
}

type Env = Record<string, string | undefined>;

/**
 * The environment of the process without the values Bun loaded from the project's `.env` files when it started, so
 * each rebuild can read those files again and see their changes.
 */
export function environmentWithoutEnvFiles(projectRoot: string, processEnv: Env = process.env): Env {
  const loaded: Record<string, string> = {};
  for (const name of [".env", `.env.${processEnv.NODE_ENV || "development"}`, ".env.local"]) {
    const file = join(projectRoot, name);
    if (existsSync(file)) Object.assign(loaded, parseEnvFile(readFileSync(file, "utf8")));
  }
  return Object.fromEntries(Object.entries(processEnv).filter(([name, value]) => loaded[name] !== value));
}

export interface ServerProcess {
  stop(): Promise<void>;
}

export interface Watcher {
  close(): void;
}

export interface DevDependencies {
  /** Builds with the environment the server will start with, `.env` files read again. */
  build(projectRoot: string, env?: Env, options?: BuildOptions): Promise<BuildSummary>;
  autoMigrationsEnabled(projectRoot: string): Promise<boolean>;
  addAutomaticMigration(projectRoot: string): Promise<CreatedMigration | undefined>;
  startServer(projectRoot: string, env?: Env): ServerProcess;
  /** Watches the paths, calling `onChange` with the project path that changed when it is known. */
  watch(projectRoot: string, paths: string[], onChange: (changed?: string) => void): Watcher;
  scheduler: Scheduler;
  log(line: string): void;
  error(line: string): void;
}

export interface DevSession {
  /** Rebuilds and restarts now; used by the watcher after debouncing. */
  rebuild(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when the rebuild triggered by the latest change has finished. */
  idle(): Promise<void>;
}

/**
 * Watches the paths of a project: folders recursively and files directly, plus the project folder itself, so a
 * watched top-level file or folder that is created, replaced or deleted (like `quickservicets.config.ts`) is noticed too.
 */
export function watchProject(projectRoot: string, paths: string[], onChange: (changed?: string) => void): Watcher {
  const watchers = new Map<string, FSWatcher>();
  const folders = new Set<string>();
  const watchPath = (path: string) => {
    watchers.get(path)?.close();
    watchers.delete(path);
    folders.delete(path);
    try {
      const folder = statSync(join(projectRoot, path)).isDirectory();
      if (folder) folders.add(path);
      watchers.set(path, fsWatch(join(projectRoot, path), { recursive: true }, (_event, file) => onChange(folder && file ? `${path}/${String(file).split(sep).join("/")}` : path)));
    } catch {
      // A path that does not exist is picked up by the project folder's watcher once it is created.
    }
  };
  for (const path of paths) watchPath(path);
  const topLevel = new Set(paths.filter((path) => !path.includes("/")));
  let root: FSWatcher | undefined;
  try {
    root = fsWatch(projectRoot, (_event, file) => {
      const name = file === null ? undefined : String(file);
      if (name === undefined || !topLevel.has(name)) return;
      // A watched folder reports its own changes; created or replaced files get a fresh watcher, since an editor's
      // atomic save replaces the watched file.
      if (folders.has(name) && existsSync(join(projectRoot, name))) return;
      watchPath(name);
      onChange(name);
    });
  } catch {
    root = undefined;
  }
  return {
    close: () => {
      root?.close();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

const defaultDependencies: DevDependencies = {
  build,
  async autoMigrationsEnabled(projectRoot) {
    return (await loadConfig(projectRoot)).migrations?.autoInDev ?? true;
  },
  addAutomaticMigration,
  startServer(projectRoot, env) {
    const child = Bun.spawn(["bun", join(projectRoot, ".generated/server.ts")], {
      cwd: projectRoot,
      ...(env ? { env } : {}),
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    return {
      async stop() {
        child.kill();
        await child.exited;
      },
    };
  },
  watch: watchProject,
  scheduler: realScheduler,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

async function buildOnce(projectRoot: string, deps: DevDependencies, env: Env, options: BuildOptions): Promise<BuildSummary | undefined> {
  let summary: BuildSummary;
  try {
    summary = await deps.build(projectRoot, env, options);
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  for (const line of summary.overrides ?? []) deps.log(line);
  for (const line of buildStepLines(summary.buildSteps ?? [])) deps.log(line);
  for (const warning of summary.warnings) {
    if (warning !== PENDING_MIGRATION_WARNING) deps.error(`Warning: ${warning}`);
  }
  if (summary.warnings.includes(PENDING_MIGRATION_WARNING)) {
    if (await deps.autoMigrationsEnabled(projectRoot)) {
      const created = await deps.addAutomaticMigration(projectRoot);
      if (created) deps.log(`Created ${created.file}. Run "quickservicets migrate" to apply it.`);
    } else {
      deps.error(`Warning: ${PENDING_MIGRATION_WARNING}`);
    }
  }
  return summary;
}

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The features whose build steps a burst of changes feeds, when every changed path is one of their folders or
 * `watch` paths; undefined (every step) when a change touches anything else.
 */
export function stepsFor(changed: ReadonlySet<string> | undefined, inputs: Readonly<Record<string, readonly string[]>>): string[] | undefined {
  if (!changed || changed.size === 0) return undefined;
  const keys = new Set<string>();
  for (const path of changed) {
    const owners = Object.entries(inputs).filter(([, paths]) => paths.some((folder) => within(path, folder)));
    if (owners.length === 0) return undefined;
    for (const [key] of owners) keys.add(key);
  }
  return [...keys];
}

/** `quickservicets dev`: builds, serves, and rebuilds and restarts on every change. */
export async function startDev(projectRoot: string, overrides: Partial<DevDependencies> = {}): Promise<DevSession> {
  const deps = { ...defaultDependencies, ...overrides };
  let server: ServerProcess | undefined;
  let running: Promise<void> = Promise.resolve();
  const baseEnv = environmentWithoutEnvFiles(projectRoot);
  let watcher: Watcher | undefined;
  let watched: string[] = watchPaths(undefined);
  let buildInputs: Record<string, string[]> = {};
  /** The changed paths of the current burst; undefined once a change of unknown origin arrived. */
  let changes: Set<string> | undefined = new Set();
  const flush = debounce(() => {
    const changed = changes;
    changes = new Set();
    running = running.then(() => rebuild(changed));
  }, DEBOUNCE_MS, deps.scheduler);
  const trigger = (changed?: string) => {
    if (changed === undefined) changes = undefined;
    else changes?.add(changed);
    flush();
  };
  // Enabling or disabling a feature changes the folders to watch.
  const watchFor = (paths: string[]) => {
    if (watcher && paths.join("\0") === watched.join("\0")) return;
    watcher?.close();
    watched = paths;
    watcher = deps.watch(projectRoot, paths, trigger);
  };

  async function rebuild(changed?: ReadonlySet<string>): Promise<void> {
    const env = projectEnvironment(projectRoot, baseEnv);
    const summary = await buildOnce(projectRoot, deps, env, { steps: stepsFor(changed, buildInputs) });
    if (!summary) return;
    buildInputs = summary.buildInputs ?? {};
    await server?.stop();
    server = deps.startServer(projectRoot, env);
    if (watcher) watchFor(watchPaths(summary));
    else watched = watchPaths(summary);
  }

  await rebuild();
  watchFor(watched);

  return {
    rebuild,
    idle: () => running,
    async stop() {
      watcher?.close();
      await server?.stop();
      server = undefined;
    },
  };
}

/** Stops the session and exits with 0 on SIGINT or SIGTERM. */
export function handleSignals(
  session: DevSession,
  processLike: Pick<NodeJS.Process, "once" | "exit"> = process,
): void {
  const shutdown = async () => {
    await session.stop();
    processLike.exit(0);
  };
  processLike.once("SIGINT", shutdown);
  processLike.once("SIGTERM", shutdown);
}
