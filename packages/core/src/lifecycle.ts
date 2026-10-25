import type { ResolvedConfig } from "./config.ts";
import type { FeatureApis, ResolvedFeature } from "./features.ts";
import { events, type Events } from "./features/events/bus.ts";
import type { HookCall, Repositories } from "./hooks.ts";
import type { Endpoint, Server, ServerSettings } from "./http/server.ts";
import { parseDuration } from "./jobs/job.ts";
import { jsonLogger, maskedLogger, safeLog, type Logger } from "./logger.ts";
import type { EntityModel } from "./model.ts";
import { join } from "node:path";
import { generatedPath } from "./build-steps.ts";
import type { Middleware, OwnedMiddleware } from "./middleware.ts";
import { prepareFeatureTargets } from "./feature-targets.ts";
import type { ParsedTags } from "./model.ts";

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
  /** `false` leaves the route's requests out of the request log, except for 5xx responses (default true). */
  log?: boolean;
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
  /** `false` when the route's requests are left out of the request log. */
  log?: boolean;
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
  /** Adds a middleware of the `request`, `handler` or `error` stage. Only available during setup. */
  use(middleware: Middleware): void;
  /**
   * Gives the HTTP server settings, like how `req.ip` is computed; two features setting the same one fail. Only
   * available during setup.
   */
  configureServer(settings: ServerSettings): void;
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
  /**
   * The absolute path of a file the feature's build step wrote in `.generated/<key>/`; throws
   * `Path <path> leaves the generated folder of <key>` for paths outside it.
   */
  generated(relativePath: string): string;
  /**
   * The public API of the enabled feature `key`, typed through `FeatureApis`. The calling feature must list `key` in
   * `requires`, `after` or `enables`, so that feature's setup ran first.
   */
  feature<K extends string>(key: K): K extends keyof FeatureApis ? FeatureApis[K] : unknown;
  /**
   * Appends a hook to one of this feature's `hook()` options, after the hooks written in the config; feature APIs
   * offer it to other features as `addHook`. Throws `Unknown hook <name> of <key>` for a name the feature does not declare.
   */
  addHook(name: string, fn: (value: never, ctx: never) => unknown): void;
  /** The bus of the `events` native; using it while the native is disabled throws. */
  events: Events;
  /**
   * The key of the feature whose setup is running now, undefined outside setups; a feature API uses it to name the
   * feature calling it.
   */
  currentFeature(): string | undefined;
}

/** A lifecycle step that failed: the feature, the phase and the error. */
export class LifecycleError extends Error {
  constructor(
    readonly feature: string,
    readonly phase: LifecyclePhase,
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
  /** The project's `.generated` folder, where build steps wrote their files (default: `.generated` in the working directory). */
  generatedDir?: string;
  /** Called with each feature's setup context before its setup runs, so extensions can add to it. */
  extendContext?: (context: FeatureSetupContext, feature: ResolvedFeature) => void;
  /**
   * The app's endpoints and generated routes, indexed before the setups run so a feature reads the tags of every route
   * there (`taggedRoutes()`); endpoints of disabled features are left out.
   */
  endpoints?: readonly { method: string; path: string; feature?: string; tags?: ParsedTags }[];
  crudRoutes?: readonly { method: string; path: string; entity: string }[];
  /** Wraps every call of a feature's lifecycle code, with the feature's key and the phase; test harnesses use it. */
  around?: <T>(feature: string, phase: LifecyclePhase, run: () => Promise<T>) => Promise<T>;
}

/** The lifecycle code a feature runs. */
export type LifecyclePhase = "setup" | "onStart" | "onShutdown" | "onStop";

/** The features' setup, start and stop steps of one process. */
export interface FeatureLifecycle {
  /** The routes the features registered during setup. */
  readonly routes: RuntimeRoute[];
  /** The middlewares the features added during setup, in feature order. */
  readonly middleware: OwnedMiddleware[];
  /** The server settings the features gave during setup. */
  readonly server: ServerSettings;
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
export function createFeatureLifecycle({ features, config, models, featureFolders = {}, worker, generatedDir = join(process.cwd(), ".generated"), extendContext, endpoints = [], crudRoutes = [], around = (_feature, _phase, run) => run() }: FeatureLifecycleOptions): FeatureLifecycle {
  const baseLogger = config.logger ?? jsonLogger;
  let masked: Logger | undefined;
  // Once a feature gives the server a masker, every entry logged through the features' loggers is masked too.
  const current = () => (server.mask ? (masked ??= maskedLogger(baseLogger, server.mask)) : baseLogger);
  const logger: Logger = { info: (entry) => current().info(entry), warn: (entry) => current().warn(entry), error: (entry) => current().error(entry) };
  const startTimeout = parseDuration(config.lifecycle.startTimeout) ?? 30_000;
  const stopTimeout = parseDuration(config.lifecycle.stopTimeout) ?? 10_000;
  const registered: Registered[] = features.map((feature) => ({ feature, onStart: [], onShutdown: [], onStop: [] }));
  const routes: RuntimeRoute[] = [];
  const middleware: OwnedMiddleware[] = [];
  const server: ServerSettings = {};
  const serverOwners = new Map<string, string>();
  const started: Registered[] = [];
  const apis = new Map<string, object>();
  const enabledKeys = new Set(features.map((feature) => feature.key));
  let settingUp: string | undefined;

  const logFailure = (error: LifecycleError) => logLifecycleFailure(logger, error);

  const runStopping = async (phase: "onShutdown" | "onStop", entries: Registered[]) => {
    for (const entry of [...entries].reverse()) {
      for (const callback of [...entry[phase]].reverse()) {
        try {
          await around(entry.feature.key, phase, () => withTimeout(callback, stopTimeout, `${entry.feature.key} ${phase}`));
        } catch (error) {
          logFailure(new LifecycleError(entry.feature.key, phase, error));
        }
      }
    }
  };

  return {
    routes,
    middleware,
    server,
    async setup() {
      prepareFeatureTargets(
        models,
        endpoints.filter((endpoint) => endpoint.feature === undefined || enabledKeys.has(endpoint.feature)),
        crudRoutes,
      );
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
            routes.push({ method: method.toUpperCase(), path, handler, hooks: normalizeHooks(options.hooks), feature: feature.key, ...(options.log === false ? { log: false } : {}) });
          },
          use: (entry) => {
            duringSetup("use");
            middleware.push({ owner: feature.key, middleware: entry });
          },
          configureServer: (settings) => {
            duringSetup("configureServer");
            for (const [name, value] of Object.entries(settings) as [keyof ServerSettings, never][]) {
              if (value === undefined) continue;
              const owner = serverOwners.get(name);
              if (owner !== undefined && owner !== feature.key) throw new Error(`Server setting ${name} is set by both ${owner} and ${feature.key}`);
              serverOwners.set(name, feature.key);
              server[name] = value;
            }
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
          generated: (relativePath) => generatedPath(join(generatedDir, feature.key), relativePath, feature.key),
          feature: ((key: string) => {
            if (!enabledKeys.has(key)) throw new Error(`${feature.key} uses ${key}, which is not enabled; add ${key}: {} to quickservice.config.ts`);
            const { requires, after, enables } = feature.definition;
            if (!requires.some((requirement) => requirement.name === key) && !after.includes(key) && !enables.includes(key)) {
              throw new Error(`${feature.key} uses ${key}; add it to requires or after`);
            }
            const api = apis.get(key);
            if (!api) throw new Error(`${key} has no feature API`);
            return api;
          }) as FeatureSetupContext["feature"],
          events,
          currentFeature: () => settingUp,
          addHook: (name, fn) => {
            const list = (feature.options as Record<string, unknown>)[name];
            if (feature.definition.schema.settings.shape?.[name]?.kind !== "hook" || !Array.isArray(list)) throw new Error(`Unknown hook ${name} of ${feature.key}`);
            if (typeof fn !== "function") throw new Error(`Hook ${name} of ${feature.key} must be a function`);
            list.push(fn);
          },
        };
        extendContext?.(context, feature);
        const { setup, api } = feature.definition;
        settingUp = feature.key;
        try {
          if (setup) await around(feature.key, "setup", () => withTimeout(() => setup(context as never), startTimeout, `${feature.key} setup`));
          if (api) apis.set(feature.key, await around(feature.key, "setup", () => withTimeout(() => api(context as never), startTimeout, `${feature.key} api`)));
        } catch (error) {
          throw new LifecycleError(feature.key, "setup", error);
        } finally {
          open = false;
          settingUp = undefined;
        }
      }
    },
    async start(context) {
      for (const entry of registered) {
        for (const callback of entry.onStart) {
          try {
            await around(entry.feature.key, "onStart", () => withTimeout(() => callback(context), startTimeout, `${entry.feature.key} onStart`));
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
