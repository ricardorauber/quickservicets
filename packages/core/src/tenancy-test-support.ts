import { memoryAdapter } from "./adapters/memory.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { createApp, type App, type AppEndpoint, type CrudRouteEntry } from "./app.ts";
import { resolveConfig, type ResolvedConfig, type ServiceConfig } from "./config.ts";
import type { HookDefinition } from "./hooks.ts";
import type { Endpoint } from "./http/server.ts";
import type { JobDefinition } from "./jobs/job.ts";
import type { JobClock } from "./jobs/scheduler.ts";
import { createFeatureLifecycle, type FeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry, Logger } from "./logger.ts";
import { CRUD_OPERATIONS, entityRoutePath, type EntityModel, type ParsedTags } from "./model.ts";

/** Helpers shared by the tenancy tests: an app built through the feature lifecycle, with its logs captured. */

export interface TestEndpointInput {
  method?: string;
  path: string;
  handler: Endpoint;
  /** Feature tags written on the endpoint, like `{ tenancy: { on: false, options: {} } }`. */
  tags?: ParsedTags;
}

export interface TestAppOptions {
  config?: Record<string, unknown>;
  models?: EntityModel[];
  endpoints?: TestEndpointInput[];
  database?: DatabaseAdapter;
  featureFolders?: Record<string, Record<string, ReadonlyMap<string, unknown>>>;
  jobs?: ReadonlyMap<string, JobDefinition>;
  hooks?: ReadonlyMap<string, HookDefinition>;
  clock?: JobClock;
  env?: Record<string, string | undefined>;
  /** Connects the database with the models before the app is created (default true). */
  connect?: boolean;
}

export interface TestApp {
  app: App;
  config: ResolvedConfig;
  lifecycle: FeatureLifecycle;
  database: DatabaseAdapter;
  logs: (LogEntry & { level: string })[];
  logger: Logger;
  fetch(path: string, init?: RequestInit & { host?: string }): Promise<Response>;
  stop(): Promise<void>;
}

const OPERATION_ROUTES: Record<string, { method: string; item: boolean }> = {
  list: { method: "GET", item: false },
  read: { method: "GET", item: true },
  create: { method: "POST", item: false },
  update: { method: "PATCH", item: true },
  replace: { method: "PUT", item: true },
  delete: { method: "DELETE", item: true },
};

/** The generated route entries of the models, without hooks. */
export function crudRoutesOf(models: readonly EntityModel[]): CrudRouteEntry[] {
  return models
    .filter((model) => !model.internal)
    .flatMap((model) =>
      CRUD_OPERATIONS.map((operation) => {
        const { method, item } = OPERATION_ROUTES[operation]!;
        const collection = entityRoutePath(model);
        return { method, path: item ? `${collection}/[id]` : collection, entity: model.key, operation, hooks: [] };
      }),
    );
}

/** Starts an app with the given config keys through setup, createApp and start, like `startService` without a port. */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const logs: (LogEntry & { level: string })[] = [];
  const logger: Logger = {
    info: (entry) => void logs.push({ level: "info", ...entry }),
    warn: (entry) => void logs.push({ level: "warn", ...entry }),
    error: (entry) => void logs.push({ level: "error", ...entry }),
  };
  const database = options.database ?? memoryAdapter();
  const models = options.models ?? [];
  const config = resolveConfig({ database, logger, ...(options.config ?? {}) } as ServiceConfig, options.env ?? {});
  const endpoints: AppEndpoint[] = (options.endpoints ?? []).map((endpoint) => ({
    method: endpoint.method ?? "GET",
    path: endpoint.path,
    hooks: [],
    handler: endpoint.handler,
    ...(endpoint.tags ? { tags: endpoint.tags } : {}),
  }));
  const crudRoutes = crudRoutesOf(models);
  const lifecycle = createFeatureLifecycle({
    features: config.features,
    config,
    models,
    featureFolders: options.featureFolders ?? {},
    worker: { index: 0, count: 1, runsScheduledWork: true },
    endpoints,
    crudRoutes,
  });
  await lifecycle.setup();
  if (options.connect !== false) await database.connect(models);
  const app = createApp({
    models,
    crudRoutes,
    endpoints,
    hooks: options.hooks ?? new Map(),
    config,
    jobs: options.jobs ?? new Map(),
    ...(options.clock ? { clock: options.clock } : {}),
    featureFolders: (options.featureFolders ?? {}) as never,
    runtimeRoutes: lifecycle.routes,
    middleware: lifecycle.middleware,
    server: lifecycle.server,
  });
  await lifecycle.start({ repos: app.repos as never, server: app.server });
  let stopped = false;
  return {
    app,
    config,
    lifecycle,
    database,
    logs,
    logger,
    fetch: (path, init = {}) => {
      const { host, ...rest } = init;
      return app.server.fetch(new Request(`http://${host ?? "localhost"}${path}`, rest));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await lifecycle.shutdown();
      await app.shutdown();
      await lifecycle.stop();
    },
  };
}

/** The error code and message of a JSON error response, with its status. */
export async function errorOf(response: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return { status: response.status, code: body.error.code, message: body.error.message };
}
