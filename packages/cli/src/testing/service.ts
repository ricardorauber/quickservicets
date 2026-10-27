import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createApp,
  createFeatureLifecycle,
  defineFeature,
  LifecycleError,
  memoryAdapter,
  notifyShutdownSignal,
  registerProjectFeatures,
  resolveConfig,
  type App,
  type AuthProvider,
  type LifecyclePhase,
  type Repositories,
  type ServiceConfig,
} from "@quickservicets/core";
import { build } from "../build/build.ts";

/** What `startTestService` takes: the project's files and the environment it starts with. */
export interface TestServiceOptions {
  /** The project's files by project-relative path, like `quickservicets.config.ts` and `entities/Post.ts`. */
  files: Record<string, string>;
  /** The environment variables of the build and the service (default: none). */
  env?: Record<string, string>;
  /**
   * Authentication providers registered with the `auth` native for the test, like `testAuth()` of
   * `@quickservicets/core/testing`; the project's config must enable `auth`.
   */
  auth?: AuthProvider | readonly AuthProvider[];
}

/** The key of the project feature that registers the providers of the `auth` option. */
const TEST_AUTH_FEATURE = "test-auth";

/** A project feature that registers the given providers with the `auth` native during its setup. */
function testAuthFeature(providers: readonly AuthProvider[]) {
  return defineFeature({
    key: TEST_AUTH_FEATURE,
    enabledByDefault: true,
    requires: [{ name: "auth", hint: "the auth option of startTestService registers its providers with it" }],
    setup(ctx) {
      for (const provider of providers) ctx.feature("auth").provider(provider);
    },
  });
}

/** A project running in the test process. */
export interface TestService {
  /**
   * Calls the running app without opening a port; `path` is like `/posts?limit=5`, and `peer` is the client socket's
   * address (default: none, so `req.ip` is `unknown`).
   */
  fetch(path: string, init?: RequestInit & { peer?: string }): Promise<Response>;
  repos: Repositories;
  /**
   * Opens a port on localhost (a free one by default) for clients that need a real connection, like WebSockets, and
   * resolves its base URL, like `http://localhost:51234`; `stop()` closes it.
   */
  listen(port?: number): Promise<{ url: string; port: number }>;
  /** The temporary project folder. */
  root: string;
  /**
   * Runs the shutdown sequence and removes the folder; fails naming the feature and phase whose code created a timer
   * that is still active after `onStop`.
   */
  stop(): Promise<void>;
}

/** The folders of the framework packages this CLI runs with, in the repository or in a project's `node_modules`. */
const CLI_PACKAGE = join(import.meta.dir, "../..");
const CORE_PACKAGE = dirname(dirname(Bun.resolveSync("@quickservicets/core", import.meta.dir)));

type TimerOwner = { feature: string; phase: LifecyclePhase };

/** Timers created while feature lifecycle code runs, per running test service, while at least one is running. */
const trackers = new Set<Map<unknown, TimerOwner>>();
let current: { owner: TimerOwner; tracker: Map<unknown, TimerOwner> } | undefined;
let originals: Pick<typeof globalThis, "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval"> | undefined;

function untrack(handle: unknown): void {
  for (const tracker of trackers) {
    for (const key of tracker.keys()) if (key === handle || Number(key) === Number(handle)) tracker.delete(key);
  }
}

/** Replaces the global timer functions with versions that record the timers feature code creates. */
function installTimerTracking(tracker: Map<unknown, TimerOwner>): void {
  trackers.add(tracker);
  if (originals) return;
  const saved = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
  originals = saved;
  globalThis.setInterval = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = saved.setInterval(handler, ms, ...args);
    if (current) current.tracker.set(handle, current.owner);
    return handle;
  }) as typeof setInterval;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (!current) return saved.setTimeout(handler, ms, ...args);
    const { tracker, owner } = current;
    const handle = saved.setTimeout((...values: unknown[]) => {
      tracker.delete(handle);
      handler(...values);
    }, ms, ...args);
    tracker.set(handle, owner);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearInterval = ((handle: unknown) => (untrack(handle), saved.clearInterval(handle as never))) as typeof clearInterval;
  globalThis.clearTimeout = ((handle: unknown) => (untrack(handle), saved.clearTimeout(handle as never))) as typeof clearTimeout;
}

function uninstallTimerTracking(tracker: Map<unknown, TimerOwner>): void {
  trackers.delete(tracker);
  if (trackers.size > 0 || !originals) return;
  Object.assign(globalThis, originals);
  originals = undefined;
}

/** Writes a temporary project linked to this repository's packages. */
function writeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "quickservicets-test-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, "node_modules/@quickservicets"), { recursive: true });
  symlinkSync(CORE_PACKAGE, join(root, "node_modules/@quickservicets/core"), "dir");
  symlinkSync(CLI_PACKAGE, join(root, "node_modules/@quickservicets/cli"), "dir");
  return root;
}

/**
 * Writes a temporary project from `files`, builds it and starts it in the test process on the memory adapter: the
 * features' setups and `onStart` callbacks run, but no port is opened. Rejects with the build output or the startup
 * error, removing the folder.
 */
export async function startTestService({ files, env = {}, auth }: TestServiceOptions): Promise<TestService> {
  const root = writeProject(files);
  const tracker = new Map<unknown, TimerOwner>();
  let started: { app: App; stop(): Promise<void> } | undefined;
  try {
    try {
      await build(root, { ...env });
    } catch (error) {
      throw new Error(`Build failed:\n${error instanceof Error ? error.message : String(error)}`);
    }
    const generated = join(root, ".generated");
    const projectConfig = (await import(join(root, "quickservicets.config.ts"))).default as ServiceConfig;
    const { models } = await import(join(generated, "models.ts"));
    const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
    const { jobs } = await import(join(generated, "jobs.ts"));
    const { features, featureFolders } = await import(join(generated, "features.ts"));
    const openApi = (await import(join(generated, "openapi.json"))).default;
    const providers = auth === undefined ? [] : Array.isArray(auth) ? auth : [auth as AuthProvider];
    registerProjectFeatures(providers.length > 0 ? [...features, { folder: TEST_AUTH_FEATURE, definition: testAuthFeature(providers) }] : features);
    const config = resolveConfig({ ...projectConfig, database: memoryAdapter() }, { ...env }, root);
    installTimerTracking(tracker);
    const lifecycle = createFeatureLifecycle({
      features: config.features,
      config,
      models,
      featureFolders,
      worker: { index: 0, count: 1, runsScheduledWork: true },
      generatedDir: generated,
      endpoints,
      crudRoutes,
      around: async (feature, phase, run) => {
        const previous = current;
        current = { owner: { feature, phase }, tracker };
        try {
          return await run();
        } finally {
          current = previous;
        }
      },
    });
    let connected = false;
    try {
      await lifecycle.setup();
      await config.database.connect(models, { defaultSchema: config.schema });
      connected = true;
      const app = createApp({ models, crudRoutes, endpoints, hooks, config, openApi, jobs, featureFolders, runtimeRoutes: lifecycle.routes, middleware: lifecycle.middleware, server: lifecycle.server });
      started = {
        app,
        async stop() {
          // As a shutdown signal does: readiness drains before the onShutdown callbacks.
          notifyShutdownSignal();
          await lifecycle.shutdown();
          await app.shutdown();
          await lifecycle.stop();
          await config.database.disconnect();
        },
      };
      await lifecycle.start({ repos: app.repos as unknown as Repositories, server: app.server });
    } catch (error) {
      await lifecycle.stop();
      if (connected) await config.database.disconnect();
      throw error instanceof LifecycleError ? new Error(`Startup failed: ${error.message}`) : error;
    }
  } catch (error) {
    uninstallTimerTracking(tracker);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const { app } = started;
  let listening: ReturnType<typeof app.server.listen> | undefined;
  return {
    root,
    repos: app.repos as unknown as Repositories,
    async listen(port = 0) {
      listening ??= app.server.listen(port);
      return { url: `http://localhost:${listening.port}`, port: listening.port ?? 0 };
    },
    fetch: (path, init) => app.server.fetch(new Request(new URL(path, "http://localhost").href, init), init?.peer === undefined ? undefined : { peer: init.peer }),
    async stop() {
      try {
        // The listener closes after the onShutdown callbacks, which close open sockets and streams.
        const server = listening;
        listening = undefined;
        await started.stop();
        await server?.stop(true);
      } finally {
        const leaked = [...tracker];
        for (const [handle] of leaked) originals?.clearInterval(handle as never);
        uninstallTimerTracking(tracker);
        rmSync(root, { recursive: true, force: true });
        const [first] = leaked;
        if (first) throw new Error(`A timer created by ${first[1].feature} in ${first[1].phase} is still active after onStop`);
      }
    },
  };
}
