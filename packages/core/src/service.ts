import { createApp, type App, type AppEndpoint, type CrudRouteEntry, type FeatureFolderRegistry } from "./app.ts";
import { MEMORY_IN_PRODUCTION, resolveConfig, type ResolvedConfig, type ServiceConfig } from "./config.ts";
import { logConfigWarnings } from "./environment.ts";
import { logEnabledFeatures, registerProjectFeatures, type ProjectFeatureModule } from "./features.ts";
import type { HookDefinition } from "./hooks.ts";
import type { JobDefinition } from "./jobs/job.ts";
import { handleShutdownSignals, type SignalTarget } from "./jobs/lifecycle.ts";
import { createFeatureLifecycle, LifecycleError, logLifecycleFailure, notifyShutdownSignal, withTimeout, type FeatureLifecycle, type FeatureSetupContext } from "./lifecycle.ts";
import { parseDuration } from "./jobs/job.ts";
import { flushLogs, jsonLogger, safeLog } from "./logger.ts";
import { MIGRATIONS_TABLE_RENAMED, renameLegacyMigrationTables } from "./legacy-names.ts";
import { reportStartupFailure } from "./error-reports.ts";
import type { EntityModel } from "./model.ts";
import type { ResolvedFeature } from "./features.ts";
import { loadServerTls, logServerCertificate } from "./tls.ts";
import { reloadTls, setTlsRestart } from "./tls-reload.ts";

/** The pause between two workers restarting for renewed certificates, after the previous one stopped. */
export const TLS_RESTART_GAP_MS = 2000;
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
  if (config.production && config.database.kind === "memory") safeLog(config.logger ?? jsonLogger, "warn", { timestamp: new Date().toISOString(), message: MEMORY_IN_PRODUCTION });
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
  const fail = async (error: unknown, connected: boolean, phase?: string) => {
    if (error instanceof LifecycleError) logLifecycleFailure(logger, error);
    else safeLog(logger, "error", { timestamp: new Date().toISOString(), message: "service.failed", error: { message: (error as Error)?.message ?? String(error), stack: (error as Error)?.stack } });
    // An error reporter set up before the failure gets it, and delivers it before the process exits.
    await reportStartupFailure(error instanceof LifecycleError ? error.cause : error, error instanceof LifecycleError ? { feature: error.feature, phase: error.phase } : phase ? { phase } : {});
    await lifecycle.stop();
    if (connected) await disconnect(config);
    flushLogs();
    target.exit(1);
    return undefined;
  };

  // The certificate and key are read and checked before anything starts, and described once per worker.
  if (config.server.tls) {
    try {
      logServerCertificate(logger, loadServerTls(config.server.tls).info, config.server.tls);
    } catch (error) {
      return fail(error, false, "tls");
    }
  }
  try {
    await lifecycle.setup();
  } catch (error) {
    return fail(error, false);
  }
  try {
    await config.database.connect(options.models, { defaultSchema: config.schema, workers: config.server.workers });
  } catch (error) {
    return fail(error, false, "connect");
  }
  try {
    for (const table of await renameLegacyMigrationTables(config.database as { kind?: string; client?: unknown })) {
      safeLog(logger, "info", { timestamp: new Date().toISOString(), message: MIGRATIONS_TABLE_RENAMED, from: table.from, to: table.to });
    }
  } catch (error) {
    return fail(error, true, "connect");
  }
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
  console.log(`QuickService.ts listening on ${config.server.tls ? "https" : "http"}://localhost:${listening.port}`);
  if (runsScheduledWork(env)) app.scheduler.start();
  const stopping = () => stopService(config, app, lifecycle, listening);
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= stopping().finally(() => {
      if (onHangup) process.off("SIGHUP", onHangup);
      setTlsRestart(undefined);
    });
    return stopped;
  };
  handleShutdownSignals(stop, target);
  // SIGHUP checks the certificate files at once; a runtime refusing renewed certificates drains this worker, which
  // exits so the supervisor starts a replacement, one worker at a time (later workers wait their turn).
  let onHangup: (() => void) | undefined;
  if (config.server.tls) {
    onHangup = () => void reloadTls(logger);
    process.on("SIGHUP", onHangup);
    const index = workerIndex(env) ?? 0;
    setTlsRestart(() => {
      const turn = index * ((parseDuration(config.lifecycle.stopTimeout) ?? 10_000) + TLS_RESTART_GAP_MS);
      setTimeout(() => void stop().then(() => target.exit(0)), turn);
    });
  }
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
