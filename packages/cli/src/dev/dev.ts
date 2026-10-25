import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@quickservice/core";
import { build, PENDING_MIGRATION_WARNING, type BuildSummary } from "../build/build.ts";
import { addAutomaticMigration, type CreatedMigration } from "../migrations/add.ts";
import { parseEnvFile, projectEnvironment } from "../env/env-check.ts";
import { existsSync, readFileSync } from "node:fs";
import { debounce, realScheduler, type Scheduler } from "./debounce.ts";

export const DEBOUNCE_MS = 200;
export const WATCHED_PATHS = ["entities", "endpoints", "hooks", "jobs", "features", "quickservice.config.ts", ".env", ".env.development", ".env.local"];

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
  build(projectRoot: string, env?: Env): Promise<BuildSummary>;
  autoMigrationsEnabled(projectRoot: string): Promise<boolean>;
  addAutomaticMigration(projectRoot: string): Promise<CreatedMigration | undefined>;
  startServer(projectRoot: string, env?: Env): ServerProcess;
  watch(projectRoot: string, paths: string[], onChange: () => void): Watcher;
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
  watch(projectRoot, paths, onChange) {
    const watchers = paths.flatMap((path) => {
      try {
        return [fsWatch(join(projectRoot, path), { recursive: true }, onChange)];
      } catch {
        return [];
      }
    });
    return { close: () => watchers.forEach((watcher) => watcher.close()) };
  },
  scheduler: realScheduler,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

async function buildOnce(projectRoot: string, deps: DevDependencies, env: Env): Promise<BuildSummary | undefined> {
  let summary: BuildSummary;
  try {
    summary = await deps.build(projectRoot, env);
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  for (const line of summary.overrides ?? []) deps.log(line);
  for (const warning of summary.warnings) {
    if (warning !== PENDING_MIGRATION_WARNING) deps.error(`Warning: ${warning}`);
  }
  if (summary.warnings.includes(PENDING_MIGRATION_WARNING)) {
    if (await deps.autoMigrationsEnabled(projectRoot)) {
      const created = await deps.addAutomaticMigration(projectRoot);
      if (created) deps.log(`Created ${created.file}. Run "quickservice migrate" to apply it.`);
    } else {
      deps.error(`Warning: ${PENDING_MIGRATION_WARNING}`);
    }
  }
  return summary;
}

/** `quickservice dev`: builds, serves, and rebuilds and restarts on every change. */
export async function startDev(projectRoot: string, overrides: Partial<DevDependencies> = {}): Promise<DevSession> {
  const deps = { ...defaultDependencies, ...overrides };
  let server: ServerProcess | undefined;
  let running: Promise<void> = Promise.resolve();
  const baseEnv = environmentWithoutEnvFiles(projectRoot);
  let watcher: Watcher | undefined;
  let watched: string[] = watchPaths(undefined);
  const trigger = debounce(() => {
    running = running.then(rebuild);
  }, DEBOUNCE_MS, deps.scheduler);
  // Enabling or disabling a feature changes the folders to watch.
  const watchFor = (paths: string[]) => {
    if (watcher && paths.join("\0") === watched.join("\0")) return;
    watcher?.close();
    watched = paths;
    watcher = deps.watch(projectRoot, paths, trigger);
  };

  async function rebuild(): Promise<void> {
    const env = projectEnvironment(projectRoot, baseEnv);
    const summary = await buildOnce(projectRoot, deps, env);
    if (!summary) return;
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
