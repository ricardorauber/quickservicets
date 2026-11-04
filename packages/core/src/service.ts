import { createApp, type App, type AppEndpoint, type CrudRouteEntry, type FeatureFolderRegistry } from "./app.ts";
import type { OpenApiInput } from "./http/docs.ts";
import { MEMORY_IN_PRODUCTION, resolveConfig, type ResolvedConfig, type ServiceConfig } from "./config.ts";
import { logConfigWarnings } from "./environment.ts";
import { logEnabledFeatures, registerProjectFeatures, type ProjectFeatureModule } from "./features.ts";
import type { HookDefinition } from "./hooks.ts";
import type { JobDefinition } from "./jobs/job.ts";
import { handleShutdownSignals, type SignalTarget } from "./jobs/lifecycle.ts";
import { createFeatureLifecycle, LifecycleError, logLifecycleFailure, notifyShutdownSignal, withTimeout, type FeatureLifecycle, type FeatureSetupContext } from "./lifecycle.ts";
import { parseDuration } from "./jobs/job.ts";
import { flushLogs, jsonLogger, safeLog, type Logger } from "./logger.ts";
import { MIGRATIONS_TABLE_RENAMED, renameLegacyMigrationTables } from "./legacy-names.ts";
import { reportStartupFailure } from "./error-reports.ts";
import type { EntityModel } from "./model.ts";
import { databaseAdapters, databasesReport, errorDatabase, placeFeatureEntities } from "./named-databases.ts";
import type { ResolvedFeature } from "./features.ts";
import { loadServerTls, logServerCertificate } from "./tls.ts";
import { reloadTls, setTlsRestart } from "./tls-reload.ts";
import { containsSecretReference } from "./secret-references.ts";

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
  openApi?: OpenApiInput;
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

/** The worker a service instance runs as. */
export interface ServiceWorker {
  index: number;
  count: number;
  /** Whether this instance runs the scheduler, consumer loops and other scheduled work. */
  runsScheduledWork: boolean;
}

/** A service initialized in this process: config, app and lifecycle, ready to serve requests and run jobs. */
export interface InitializedService {
  config: ResolvedConfig;
  app: App;
  lifecycle: FeatureLifecycle;
  /** The jobs of the project, by name. */
  jobs: ReadonlyMap<string, JobDefinition>;
  /** Runs `onShutdown` callbacks, drains jobs, runs `onStop` callbacks and disconnects. */
  stop(): Promise<void>;
}

/** The config and models of a service, resolved from the generated inputs, with when the preparation started. */
interface PreparedService {
  config: ResolvedConfig;
  options: StartServiceOptions;
  startedAt: number;
  configMs: number;
}

/** Milliseconds since a start, rounded to a tenth. */
const since = (start: number) => Math.round((performance.now() - start) * 10) / 10;

/** Registers the project's features, resolves the config and places the feature entities. */
function prepareService(options: StartServiceOptions): PreparedService {
  const startedAt = performance.now();
  const env = options.env ?? process.env;
  registerProjectFeatures(options.features ?? []);
  const config = resolveConfig(options.projectConfig, env);
  // Feature entities live where the features' `database` options of this environment place them.
  const placed = { ...options, models: placeFeatureEntities(options.models, config.features) };
  logConfigWarnings(config);
  if (config.production && config.database.kind === "memory") safeLog(config.logger ?? jsonLogger, "warn", { timestamp: new Date().toISOString(), message: MEMORY_IN_PRODUCTION });
  return { config, options: placed, startedAt, configMs: since(startedAt) };
}

/**
 * Runs the features' setups, connects the database, creates the app and runs the `onStart` callbacks: the pipeline
 * `startService` and the platform handler share. On a failure, `onFailure` runs first (with the phase when no feature
 * owns it), then what started is stopped and the database disconnected, and the error is rethrown.
 */
/** Runs when the initialization of a service fails, before what started is stopped. */
export type ServiceFailureHandler = (error: unknown, phase: string | undefined, logger: Logger) => Promise<void> | void;

async function bootService(prepared: PreparedService, worker: ServiceWorker, onFailure: ServiceFailureHandler): Promise<InitializedService> {
  const { config, options } = prepared;
  const logger = config.logger ?? jsonLogger;
  // With deploy.startupTrace (QS_DEPLOY_STARTUP_TRACE=true), each feature's setup and onStart are timed too.
  const trace = (config.features.find((feature) => feature.key === "deploy")?.options as { startupTrace?: boolean } | undefined)?.startupTrace === true;
  const featureTimes: Record<string, { setup?: number; onStart?: number }> = {};
  const around = async <T>(feature: string, phase: "setup" | "onStart" | "onShutdown" | "onStop", run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await run();
    } finally {
      if (phase === "setup" || phase === "onStart") {
        const entry = (featureTimes[feature] ??= {});
        entry[phase] = Math.round(((entry[phase] ?? 0) + performance.now() - start) * 10) / 10;
      }
    }
  };
  const phases = { config: prepared.configMs, setup: 0, connect: 0, start: 0 };
  let phaseStart = performance.now();
  const lifecycle = createFeatureLifecycle({
    features: config.features,
    config,
    models: options.models,
    featureFolders: options.featureFolders,
    worker,
    generatedDir: options.generatedDir,
    extendContext: options.extendSetupContext,
    endpoints: options.endpoints,
    crudRoutes: options.crudRoutes,
    ...(trace ? { around } : {}),
  });
  const fail = async (error: unknown, connected: boolean, phase?: string): Promise<never> => {
    await onFailure(error, phase, logger);
    await lifecycle.stop();
    if (connected) await disconnect(config);
    throw error;
  };
  // The certificate and key are read and checked before anything starts, and described once per worker; secret
  // references among them are resolved first, by the setup of the secrets native.
  const checkTls = () => {
    if (!config.server.tls) return true;
    try {
      logServerCertificate(logger, loadServerTls(config.server.tls).info, config.server.tls);
      return true;
    } catch (error) {
      return error;
    }
  };
  const tlsReferences = containsSecretReference(config.server.tls);
  if (!tlsReferences) {
    const checked = checkTls();
    if (checked !== true) return fail(checked, false, "tls");
  }
  try {
    await lifecycle.setup();
  } catch (error) {
    return fail(error, false);
  }
  if (tlsReferences) {
    const checked = checkTls();
    if (checked !== true) return fail(checked, false, "tls");
  }
  phases.setup = since(phaseStart);
  phaseStart = performance.now();
  try {
    await config.database.connect(options.models, { defaultSchema: config.schema, workers: config.server.workers });
  } catch (error) {
    return fail(error, false, "connect");
  }
  // With named databases, each database's kind and entity count, never its connection.
  const report = databasesReport(config.database, options.models);
  if (report) safeLog(logger, "info", { timestamp: new Date().toISOString(), message: report });
  try {
    // Every database keeps its own migrations table.
    for (const [, adapter] of databaseAdapters(config.database)) {
      for (const table of await renameLegacyMigrationTables(adapter as { kind?: string; client?: unknown })) {
        safeLog(logger, "info", { timestamp: new Date().toISOString(), message: MIGRATIONS_TABLE_RENAMED, from: table.from, to: table.to });
      }
    }
  } catch (error) {
    return fail(error, true, "connect");
  }
  phases.connect = since(phaseStart);
  phaseStart = performance.now();
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
  phases.start = since(phaseStart);
  safeLog(logger, "info", { timestamp: new Date().toISOString(), message: "service.started", durationMs: since(prepared.startedAt), phases, ...(trace ? { features: featureTimes } : {}) });
  const jobs = options.jobs ?? new Map<string, JobDefinition>();
  return { config, app, lifecycle, jobs, stop: () => stopService(config, app, lifecycle) };
}

/**
 * Initializes one service instance in this process from the inputs of `startService`, without listening: config,
 * feature setups, the database, the app and the `onStart` callbacks. `onFailure` runs before what started is stopped.
 */
export async function initializeService(options: StartServiceOptions, worker: ServiceWorker, onFailure: ServiceFailureHandler = () => {}): Promise<InitializedService> {
  const prepared = prepareService(options);
  logEnabledFeatures(prepared.config);
  return bootService(prepared, worker, onFailure);
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
  const prepared = prepareService(options);
  const { config } = prepared;
  if (isPrimary(config, env)) {
    // With several workers this process only supervises them; each worker runs the script again.
    await runWorkers(config, options.script ?? Bun.main);
    return undefined;
  }
  logEnabledFeatures(config);
  const logger = config.logger ?? jsonLogger;
  let service: InitializedService;
  try {
    service = await bootService(prepared, { index: workerIndex(env) ?? 0, count: config.server.workers, runsScheduledWork: runsScheduledWork(env) }, async (error, phase) => {
      if (error instanceof LifecycleError) logLifecycleFailure(logger, error);
      else safeLog(logger, "error", { timestamp: new Date().toISOString(), message: "service.failed", error: { message: (error as Error)?.message ?? String(error), stack: (error as Error)?.stack } });
      // An error reporter set up before the failure gets it, and delivers it before the process exits.
      await reportStartupFailure(error instanceof LifecycleError ? error.cause : error, error instanceof LifecycleError ? { feature: error.feature, phase: error.phase } : phase ? { phase } : {});
    });
  } catch {
    flushLogs();
    target.exit(1);
    return undefined;
  }
  const { app, lifecycle } = service;
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
    // With named databases, every database disconnects within the stop time limit.
    if (Object.keys(config.databases ?? {}).length === 0) await config.database.disconnect();
    else await withTimeout(() => config.database.disconnect(), parseDuration(config.lifecycle.stopTimeout) ?? 10_000, "disconnecting the databases");
  } catch (error) {
    const database = errorDatabase(error);
    safeLog(config.logger ?? jsonLogger, "error", { timestamp: new Date().toISOString(), message: "database.disconnect", ...(database ? { database } : {}), error: { message: (error as Error)?.message ?? String(error) } });
  }
}

/**
 * `onShutdown` callbacks, the listener (when there is one) closed and jobs drained, `onStop` callbacks, then the
 * database disconnected.
 */
async function stopService(config: ResolvedConfig, app: App, lifecycle: FeatureLifecycle, listening?: { stop(close?: boolean): Promise<void> | void }): Promise<void> {
  notifyShutdownSignal();
  await lifecycle.shutdown();
  // In-flight requests finish while jobs drain; idle keep-alive connections never hold the shutdown longer than the limit.
  await Promise.all([listening ? withTimeout(() => listening.stop(), parseDuration(config.lifecycle.stopTimeout) ?? 10_000, "closing the listener").catch(() => {}) : undefined, app.shutdown()]);
  await lifecycle.stop();
  await disconnect(config);
}
