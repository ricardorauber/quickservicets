import type { ResolvedConfig } from "./config.ts";
import type { ResolvedFeature } from "./features.ts";
import type { HookCall, Repositories } from "./hooks.ts";
import type { Endpoint, Server } from "./http/server.ts";
import { parseDuration } from "./jobs/job.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import type { EntityModel } from "./model.ts";

/** Which worker process runs a feature's setup. */
export interface WorkerInfo {
  /** 0 in a single process, the worker's number otherwise. */
  index: number;
  /** How many worker processes serve requests. */
  count: number;
  /** Whether this process runs scheduled work (only worker 0 does). */
  runsScheduledWork: boolean;
}

/** What `onStart` callbacks receive. */
export interface StartContext {
  repos: Repositories;
  server: Server;
}

type Callback<A extends unknown[] = []> = (...args: A) => void | Promise<void>;

/** Options of a route a feature registers at runtime. */
export interface RuntimeRouteOptions {
  /** Hooks of `hooks/` run around the handler, by name or with arguments. */
  hooks?: readonly (string | HookCall)[];
}

/** A route a feature registered at runtime with `ctx.app.route`. */
export interface RuntimeRoute {
  method: string;
  /** The path, with `[param]` segments and an optional trailing `[...rest]` segment. */
  path: string;
  handler: Endpoint;
  hooks: HookCall[];
  /** The key of the feature that registered it. */
  feature: string;
}

/** The running service's extension points a feature reaches from its setup. */
export interface FeatureApp {
  /** Runs `fn` after the app is created and before the server listens, in feature order. */
  onStart(fn: Callback<[StartContext]>): void;
  /** Runs `fn` when a shutdown signal arrives, before the listener closes and jobs drain, in reverse feature order. */
  onShutdown(fn: Callback): void;
  /** Runs `fn` after the listener closed and jobs drained, before the database disconnects, in reverse feature order. */
  onStop(fn: Callback): void;
  /**
   * Adds a route with the endpoint signature; the path may use `[param]` segments and end with `[...rest]`, which
   * receives the rest of the path in `req.params.rest`. Only available during setup.
   */
  route(method: string, path: string, handler: Endpoint, options?: RuntimeRouteOptions): void;
}

/** What a feature's `setup(ctx)` receives. */
export interface FeatureSetupContext<O = Record<string, unknown>> {
  /** The feature's resolved options. */
  options: O;
  config: ResolvedConfig;
  models: readonly EntityModel[];
  /** The default exports of this feature's convention folders, by folder name and file name. */
  folders: Readonly<Record<string, ReadonlyMap<string, unknown>>>;
  /** The configured logger, adding `feature: "<key>"` to each entry. */
  logger: Logger;
  worker: WorkerInfo;
  app: FeatureApp;
}

/** A lifecycle step that failed: the feature, the phase and the error. */
export class LifecycleError extends Error {
  constructor(
    readonly feature: string,
    readonly phase: "setup" | "onStart" | "onShutdown" | "onStop",
    readonly cause: unknown,
  ) {
    super(`${feature} failed in ${phase}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LifecycleError";
  }
}

/** Resolves with `work`, or rejects when it takes longer than `ms`. */
export async function withTimeout<T>(work: () => T | Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A logger that adds the feature's key to every entry. */
export function featureLogger(logger: Logger, key: string): Logger {
  return {
    info: (entry) => logger.info({ ...entry, feature: key }),
    warn: (entry) => logger.warn({ ...entry, feature: key }),
    error: (entry) => logger.error({ ...entry, feature: key }),
  };
}

const normalizeHooks = (hooks: RuntimeRouteOptions["hooks"] = []): HookCall[] =>
  hooks.map((hook) => (typeof hook === "string" ? { name: hook, args: [] } : { name: hook.name, args: [...hook.args] }));

export interface FeatureLifecycleOptions {
  features: readonly ResolvedFeature[];
  config: ResolvedConfig;
  models: readonly EntityModel[];
  featureFolders?: Readonly<Record<string, Readonly<Record<string, ReadonlyMap<string, unknown>>>>>;
  worker: WorkerInfo;
  /** Called with each feature's setup context before its setup runs, so extensions can add to it. */
  extendContext?: (context: FeatureSetupContext, feature: ResolvedFeature) => void;
}

/** The features' setup, start and stop steps of one process. */
export interface FeatureLifecycle {
  /** The routes the features registered during setup. */
  readonly routes: RuntimeRoute[];
  /** Runs each feature's `setup` in order; throws a `LifecycleError` on the first failure or timeout. */
  setup(): Promise<void>;
  /** Runs the `onStart` callbacks in feature order; throws a `LifecycleError` on the first failure or timeout. */
  start(context: StartContext): Promise<void>;
  /** Runs the `onShutdown` callbacks in reverse order, logging failures and timeouts. */
  shutdown(): Promise<void>;
  /** Runs the `onStop` callbacks of the started features in reverse order, logging failures and timeouts. */
  stop(): Promise<void>;
}

interface Registered {
  feature: ResolvedFeature;
  onStart: Callback<[StartContext]>[];
  onShutdown: Callback[];
  onStop: Callback[];
}

/** Runs the enabled features' setups and the callbacks they register, with the `lifecycle` time limits. */
export function createFeatureLifecycle({ features, config, models, featureFolders = {}, worker, extendContext }: FeatureLifecycleOptions): FeatureLifecycle {
  const logger = config.logger ?? jsonLogger;
  const startTimeout = parseDuration(config.lifecycle.startTimeout) ?? 30_000;
  const stopTimeout = parseDuration(config.lifecycle.stopTimeout) ?? 10_000;
  const registered: Registered[] = features.map((feature) => ({ feature, onStart: [], onShutdown: [], onStop: [] }));
  const routes: RuntimeRoute[] = [];
  const started: Registered[] = [];

  const logFailure = (error: LifecycleError) => logLifecycleFailure(logger, error);

  const runStopping = async (phase: "onShutdown" | "onStop", entries: Registered[]) => {
    for (const entry of [...entries].reverse()) {
      for (const callback of [...entry[phase]].reverse()) {
        try {
          await withTimeout(callback, stopTimeout, `${entry.feature.key} ${phase}`);
        } catch (error) {
          logFailure(new LifecycleError(entry.feature.key, phase, error));
        }
      }
    }
  };

  return {
    routes,
    async setup() {
      for (const entry of registered) {
        const { feature } = entry;
        let open = true;
        const duringSetup = (name: string) => {
          if (!open) throw new Error(`ctx.app.${name} of ${feature.key} is only available during setup`);
        };
        const app: FeatureApp = {
          onStart: (fn) => (duringSetup("onStart"), void entry.onStart.push(fn)),
          onShutdown: (fn) => (duringSetup("onShutdown"), void entry.onShutdown.push(fn)),
          onStop: (fn) => (duringSetup("onStop"), void entry.onStop.push(fn)),
          route: (method, path, handler, options = {}) => {
            duringSetup("route");
            routes.push({ method: method.toUpperCase(), path, handler, hooks: normalizeHooks(options.hooks), feature: feature.key });
          },
        };
        const context: FeatureSetupContext = {
          options: feature.options,
          config,
          models,
          folders: featureFolders[feature.key] ?? {},
          logger: featureLogger(logger, feature.key),
          worker,
          app,
        };
        extendContext?.(context, feature);
        const setup = feature.definition.setup;
        try {
          if (setup) await withTimeout(() => setup(context as never), startTimeout, `${feature.key} setup`);
        } catch (error) {
          throw new LifecycleError(feature.key, "setup", error);
        } finally {
          open = false;
        }
      }
    },
    async start(context) {
      for (const entry of registered) {
        for (const callback of entry.onStart) {
          try {
            await withTimeout(() => callback(context), startTimeout, `${entry.feature.key} onStart`);
          } catch (error) {
            throw new LifecycleError(entry.feature.key, "onStart", error);
          }
        }
        started.push(entry);
      }
    },
    shutdown: () => runStopping("onShutdown", started),
    stop: () => runStopping("onStop", started.splice(0)),
  };
}

/** Logs a lifecycle failure as `{ feature, phase, error }`. */
export function logLifecycleFailure(logger: Logger, error: LifecycleError): void {
  safeLog(logger, "error", {
    timestamp: new Date().toISOString(),
    message: "feature.failed",
    feature: error.feature,
    phase: error.phase,
    error: { message: error.cause instanceof Error ? error.cause.message : String(error.cause), ...(error.cause instanceof Error ? { stack: error.cause.stack } : {}) },
  });
}
