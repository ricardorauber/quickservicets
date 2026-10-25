import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@quickservice/core";
import { build, PENDING_MIGRATION_WARNING, type BuildSummary } from "../build/build.ts";
import { addAutomaticMigration, type CreatedMigration } from "../migrations/add.ts";
import { debounce, realScheduler, type Scheduler } from "./debounce.ts";

export const DEBOUNCE_MS = 200;
export const WATCHED_PATHS = ["entities", "endpoints", "hooks", "quickservice.config.ts"];

export interface ServerProcess {
  stop(): Promise<void>;
}

export interface Watcher {
  close(): void;
}

export interface DevDependencies {
  build(projectRoot: string): Promise<BuildSummary>;
  autoMigrationsEnabled(projectRoot: string): Promise<boolean>;
  addAutomaticMigration(projectRoot: string): Promise<CreatedMigration | undefined>;
  startServer(projectRoot: string): ServerProcess;
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
  startServer(projectRoot) {
    const child = Bun.spawn(["bun", join(projectRoot, ".generated/server.ts")], {
      cwd: projectRoot,
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

async function buildOnce(projectRoot: string, deps: DevDependencies): Promise<boolean> {
  let summary: BuildSummary;
  try {
    summary = await deps.build(projectRoot);
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return false;
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
  return true;
}

/** `quickservice dev`: builds, serves, and rebuilds and restarts on every change. */
export async function startDev(projectRoot: string, overrides: Partial<DevDependencies> = {}): Promise<DevSession> {
  const deps = { ...defaultDependencies, ...overrides };
  let server: ServerProcess | undefined;
  let running: Promise<void> = Promise.resolve();

  const rebuild = async () => {
    if (!(await buildOnce(projectRoot, deps))) return;
    await server?.stop();
    server = deps.startServer(projectRoot);
  };

  await rebuild();
  const trigger = debounce(() => {
    running = running.then(rebuild);
  }, DEBOUNCE_MS, deps.scheduler);
  const watcher = deps.watch(projectRoot, WATCHED_PATHS, trigger);

  return {
    rebuild,
    idle: () => running,
    async stop() {
      watcher.close();
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
