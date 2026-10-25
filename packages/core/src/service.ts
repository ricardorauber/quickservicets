import { createApp, type App, type AppEndpoint, type CrudRouteEntry, type FeatureFolderRegistry } from "./app.ts";
import { resolveConfig, type ResolvedConfig, type ServiceConfig } from "./config.ts";
import { logConfigWarnings } from "./environment.ts";
import { logEnabledFeatures, registerProjectFeatures, type ProjectFeatureModule } from "./features.ts";
import type { HookDefinition } from "./hooks.ts";
import type { JobDefinition } from "./jobs/job.ts";
import { handleShutdownSignals, type SignalTarget } from "./jobs/lifecycle.ts";
import { createFeatureLifecycle, LifecycleError, logLifecycleFailure, notifyShutdownSignal, withTimeout, type FeatureLifecycle, type FeatureSetupContext } from "./lifecycle.ts";
import { parseDuration } from "./jobs/job.ts";
import { flushLogs, jsonLogger, safeLog } from "./logger.ts";
import type { EntityModel } from "./model.ts";
import type { ResolvedFeature } from "./features.ts";
import { isPrimary, runsScheduledWork, runWorkers, workerIndex } from "./workers.ts";

/** What the generated `server.ts` passes to `startService`: the project's config and generated files. */
export interface StartServiceOptions {
  projectConfig: ServiceConfig;
  models: EntityModel[];
  crudRoutes: CrudRouteEntry[];
  endpoints: AppEndpoint[];
  hooks: ReadonlyMap<string, HookDefinition>;
  jobs?: ReadonlyMap<string, JobDefinition>;
  openApi?: { info?: { title?: string } };
  /** The project's features of `features/`, registered before the config is resolved. */
  features?: readonly ProjectFeatureModule[];
  featureFolders?: FeatureFolderRegistry;
  /** The environment (default: the process's). */
  env?: Record<string, string | undefined>;
  /** Receives the shutdown signals and the exit code (default: the process). */
  process?: SignalTarget;
  /** The script each worker process runs when the service uses several (default: the entry script). */
  script?: string;
  /** The project's `.generated` folder (default: `.generated` in the working directory). */
  generatedDir?: string;
  /** Adds to each feature's setup context; extensions of the lifecycle use it. */
  extendSetupContext?: (context: FeatureSetupContext, feature: ResolvedFeature) => void;
}

/** A service started in this process. */
export interface RunningService {
  config: ResolvedConfig;
  app: App;
  /** The port the server listens on. */
  port: number;
  /** Runs the shutdown sequence without exiting the process. */
  stop(): Promise<void>;
}

/**
 * Starts the service the generated `server.ts` describes: resolves the config, supervises the workers or, in a worker,
 * runs the features' setups, connects, creates the app, runs the `onStart` callbacks, listens, starts the scheduler and
 * handles the shutdown signals. A failing setup or `onStart` logs `{ feature, phase, error }`, stops what started and
 * exits with 1. Resolves once the server listens (undefined in a primary process or after a failed start).
 */
export async function startService(options: StartServiceOptions): Promise<RunningService | undefined> {
  const env = options.env ?? process.env;
  const target = options.process ?? process;
  registerProjectFeatures(options.features ?? []);
  const config = resolveConfig(options.projectConfig, env);
  logConfigWarnings(config);
  if (isPrimary(config, env)) {
    // With several workers this process only supervises them; each worker runs the script again.
    await runWorkers(config, options.script ?? Bun.main);
    return undefined;
  }
  logEnabledFeatures(config);
  const logger = config.logger ?? jsonLogger;
  const lifecycle = createFeatureLifecycle({
    features: config.features,
    config,
    models: options.models,
    featureFolders: options.featureFolders,
    worker: { index: workerIndex(env) ?? 0, count: config.server.workers, runsScheduledWork: runsScheduledWork(env) },
    generatedDir: options.generatedDir,
    extendContext: options.extendSetupContext,
    endpoints: options.endpoints,
    crudRoutes: options.crudRoutes,
  });
  const fail = async (error: unknown, connected: boolean) => {
    if (error instanceof LifecycleError) logLifecycleFailure(logger, error);
    else safeLog(logger, "error", { timestamp: new Date().toISOString(), message: "service.failed", error: { message: (error as Error)?.message ?? String(error), stack: (error as Error)?.stack } });
    await lifecycle.stop();
    if (connected) await disconnect(config);
    flushLogs();
    target.exit(1);
    return undefined;
  };

  try {
    await lifecycle.setup();
  } catch (error) {
    return fail(error, false);
  }
  await config.database.connect(options.models, { defaultSchema: config.schema, workers: config.server.workers });
  let app: App;
  try {
    app = createApp({
      models: options.models,
      crudRoutes: options.crudRoutes,
      endpoints: options.endpoints,
      hooks: options.hooks,
      config,
      openApi: options.openApi,
      jobs: options.jobs,
      featureFolders: options.featureFolders,
      runtimeRoutes: lifecycle.routes,
      middleware: lifecycle.middleware,
      server: lifecycle.server,
    });
    await lifecycle.start({ repos: app.repos as never, server: app.server });
  } catch (error) {
    return fail(error, true);
  }
  const listening = app.server.listen();
  console.log(`quickservice listening on http://localhost:${listening.port}`);
  if (runsScheduledWork(env)) app.scheduler.start();
  const stop = () => stopService(config, app, lifecycle, listening);
  handleShutdownSignals(stop, target);
  return { config, app, port: listening.port ?? 0, stop };
}

async function disconnect(config: ResolvedConfig): Promise<void> {
  try {
    await config.database.disconnect();
  } catch (error) {
    safeLog(config.logger ?? jsonLogger, "error", { timestamp: new Date().toISOString(), message: "database.disconnect", error: { message: (error as Error)?.message ?? String(error) } });
  }
}

/** `onShutdown` callbacks, the listener closed and jobs drained, `onStop` callbacks, then the database disconnected. */
async function stopService(config: ResolvedConfig, app: App, lifecycle: FeatureLifecycle, listening: { stop(close?: boolean): Promise<void> | void }): Promise<void> {
  notifyShutdownSignal();
  await lifecycle.shutdown();
  // In-flight requests finish while jobs drain; idle keep-alive connections never hold the shutdown longer than the limit.
  await Promise.all([withTimeout(() => listening.stop(), parseDuration(config.lifecycle.stopTimeout) ?? 10_000, "closing the listener").catch(() => {}), app.shutdown()]);
  await lifecycle.stop();
  await disconnect(config);
}
