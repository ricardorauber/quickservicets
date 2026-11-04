import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createApp,
  createFeatureLifecycle,
  defineFeature,
  describeInfrastructure,
  importConfigFile,
  LifecycleError,
  memoryAdapter,
  notifyShutdownSignal,
  registerProjectFeatures,
  resolveConfig,
  placeFeatureEntities,
  type App,
  type DatabaseAdapter,
  type EntityModel,
  type AuthProvider,
  type ContainerRunner,
  type InfraService,
  type LifecyclePhase,
  type Repositories,
} from "@quickservicets/core";
import { build } from "../build/build.ts";
import { startServices, type TestServices } from "./services.ts";

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
  /**
   * The adapters of the project's named databases: each one is `memoryAdapter()` unless given here, and `"config"`
   * keeps the project's own adapters (default: every named database in memory).
   */
  databases?: Record<string, DatabaseAdapter> | "config";
  /**
   * Services to start in throwaway containers first (catalog kinds like `postgres`, or requirement names of the
   * project's infrastructure description): the project then runs on its own configured adapter, connected with their
   * variables, its migrations are created and applied, and `stop()` removes the containers. `TEST_<KIND>_URL` points a
   * kind at an existing service instead.
   */
  services?: readonly string[];
}

/** The project's named databases with each adapter replaced: by `chosen[name]`, or by a memory adapter. */
function testDatabases(configured: unknown, chosen: Record<string, DatabaseAdapter> = {}): Record<string, unknown> | undefined {
  if (typeof configured !== "object" || configured === null) return undefined;
  return Object.fromEntries(
    Object.entries(configured as Record<string, unknown>).map(([name, entry]) => {
      const adapter = chosen[name] ?? memoryAdapter();
      // An entry with settings keeps them (tenancy, tenantConnection) around the replaced adapter.
      const settings = typeof entry === "object" && entry !== null && "adapter" in entry ? (entry as Record<string, unknown>) : undefined;
      return [name, settings ? { ...settings, adapter } : adapter];
    }),
  );
}

/**
 * The project's infrastructure description and the `dev` native's runner, read through a fresh import of the config,
 * so the later import still sees the services' variables.
 */
async function projectInfrastructure(root: string): Promise<{ services: InfraService[]; runner?: ContainerRunner }> {
  const file = join(root, "quickservicets.config.ts");
  if (!existsSync(file)) return { services: [] };
  const { default: projectConfig } = (await import(`${file}?describe=${crypto.randomUUID()}`)) as { default: Record<string, unknown> };
  const config = resolveConfig(projectConfig as never, { ...process.env }, root);
  const runner = config.features.find((feature) => feature.key === "dev")?.options.runner as ContainerRunner | undefined;
  return { services: describeInfrastructure(config as never).services, ...(runner ? { runner } : {}) };
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
  /** The connection variables of the started `services` (empty without them). */
  env: Record<string, string>;
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
export async function startTestService({ files, env: givenEnv = {}, auth, databases, services: serviceNames }: TestServiceOptions): Promise<TestService> {
  const root = writeProject(files);
  const tracker = new Map<unknown, TimerOwner>();
  let started: { app: App; stop(): Promise<void> } | undefined;
  let services: TestServices | undefined;
  let env: Record<string, string> = givenEnv;
  // The config file reads process.env when it is imported, so the services' variables are set while it loads.
  const restoreEnv: Record<string, string | undefined> = {};
  const releaseEnv = () => {
    for (const [name, value] of Object.entries(restoreEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    if (serviceNames && serviceNames.length > 0) {
      const infrastructure = await projectInfrastructure(root);
      services = await startServices(serviceNames, { env: { ...process.env, ...givenEnv }, services: infrastructure.services, ...(infrastructure.runner ? { runner: infrastructure.runner } : {}) });
      env = { ...services.env, ...givenEnv };
      for (const [name, value] of Object.entries(services.env)) {
        restoreEnv[name] = process.env[name];
        process.env[name] = value;
      }
    }
    try {
      await build(root, { ...env });
    } catch (error) {
      throw new Error(`Build failed:\n${error instanceof Error ? error.message : String(error)}`);
    }
    const generated = join(root, ".generated");
    const projectConfig = await importConfigFile(root);
    const generatedModels = (await import(join(generated, "models.ts"))).models as EntityModel[];
    const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
    const { jobs } = await import(join(generated, "jobs.ts"));
    const { features, featureFolders } = await import(join(generated, "features.ts"));
    const openApi = (await import(join(generated, "openapi.json"))).default;
    const providers = auth === undefined ? [] : Array.isArray(auth) ? auth : [auth as AuthProvider];
    registerProjectFeatures(providers.length > 0 ? [...features, { folder: TEST_AUTH_FEATURE, definition: testAuthFeature(providers) }] : features);
    // Named databases run in memory too, unless the test gives adapters or keeps the project's.
    const named = databases === "config" ? projectConfig.databases : testDatabases(projectConfig.databases, databases);
    if (services) {
      // The project's own adapter, on the started services, with its migrations created and applied.
      const { addAutomaticMigration } = await import("../migrations/add.ts");
      const { migrate } = await import("../migrations/migrate.ts");
      await addAutomaticMigration(root);
      await migrate(root);
    }
    const config = resolveConfig({ ...projectConfig, ...(services ? {} : { database: memoryAdapter() }), ...(named ? { databases: named as never } : {}) }, { ...env }, root);
    const models = placeFeatureEntities(generatedModels, config.features);
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
    await services?.stop();
    throw error;
  } finally {
    releaseEnv();
  }
  const { app } = started;
  let listening: ReturnType<typeof app.server.listen> | undefined;
  return {
    root,
    env: { ...services?.env },
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
        await services?.stop();
        const [first] = leaked;
        if (first) throw new Error(`A timer created by ${first[1].feature} in ${first[1].phase} is still active after onStop`);
      }
    },
  };
}
