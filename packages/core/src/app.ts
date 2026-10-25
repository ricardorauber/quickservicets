import type { ResolvedConfig } from "./config.ts";
import { configureTransactions } from "./transactions.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import type { HookCall, HookDefinition, Repositories } from "./hooks.ts";
import { createCrudRoutes, mergeRoutes, type CrudRoute } from "./http/crud.ts";
import { withHooks } from "./http/pipeline.ts";
import { docsRoutes } from "./http/docs.ts";
import { withQueryItems, type QueryItem } from "./http/query-items.ts";
import { createServer, type Endpoint, type Route, type Server, type ServerSettings } from "./http/server.ts";
import { parseDuration, type JobDefinition } from "./jobs/job.ts";
import { jobRunEntity } from "./jobs/job-run.ts";
import { createAbandonedRunMonitor, type AbandonedRunMonitor } from "./jobs/lifecycle.ts";
import { createJobRunner, createJobScheduler, type JobClock, type JobRunner, type JobScheduler } from "./jobs/scheduler.ts";
import { createJobRunCleanup, type JobRunCleanup } from "./jobs/retention.ts";
import { createRequestJobs } from "./jobs/triggers.ts";
import type { CrudOperation, EntityModel, ParsedTags } from "./model.ts";
import { prepareFeatureTargets } from "./feature-targets.ts";
import type { RuntimeRoute } from "./lifecycle.ts";
import { middlewareStages, type MiddlewareStages, type OwnedMiddleware } from "./middleware.ts";
import { REQUEST_PROPERTIES, type ServiceRequest } from "./hooks.ts";
import { patternOf } from "./http/router.ts";
import { DOCS_PATH, OPENAPI_PATH } from "./http/docs.ts";
import { projectResult, type Projection } from "./projection.ts";
import { createRepositories, repositoryFor, type RepositoryRegistry } from "./repository.ts";

/** A generated CRUD route with its resolved hook list. */
export interface CrudRouteEntry {
  method: string;
  path: string;
  entity: string;
  operation: CrudOperation;
  hooks: HookCall[];
}

/** A custom endpoint from `/endpoints` with its resolved hook list. */
export interface AppEndpoint {
  method: string;
  path: string;
  hooks: HookCall[];
  /** Applied to the handler's result before post-hooks. */
  projection?: Projection;
  /** Reference paths populated on the handler's result (entity key and paths), before the projection. */
  populate?: { entity: string; paths: string[] };
  /** Typed query items, converted into `req.queryItems` after the pre-hooks. */
  query?: QueryItem[];
  /** Success status from `@status`, used when the handler does not call `res.status`. */
  status?: number;
  /** The key of the feature whose folder holds the endpoint; left out while that feature is disabled. */
  feature?: string;
  /** Feature tags written on the endpoint. */
  tags?: ParsedTags;
  handler: Endpoint;
}

async function populateResult(result: unknown, populate: (records: never[]) => Promise<unknown[]>): Promise<unknown> {
  if (result === undefined || result === null || result instanceof Response) return result;
  if (Array.isArray(result)) return populate(result as never[]);
  if (typeof result === "object" && Array.isArray((result as { data?: unknown }).data)) {
    const container = result as { data: never[] };
    return { ...container, data: await populate(container.data) };
  }
  if (typeof result === "object") return (await populate([result as never]))[0];
  return result;
}

function withProjection(handler: Endpoint, projection: Projection | undefined): Endpoint {
  if (!projection) return handler;
  return async (repos, req, res) => projectResult(await handler(repos, req, res), projection) as never;
}

export interface AppOptions {
  models: EntityModel[];
  crudRoutes: CrudRouteEntry[];
  endpoints: AppEndpoint[];
  hooks: ReadonlyMap<string, HookDefinition>;
  config: ResolvedConfig;
  /** The OpenAPI document served at `/openapi.json` and `/docs` when `config.docs.enabled`. */
  openApi?: { info?: { title?: string } };
  /** The job registry; its jobs run at their scheduled times once `scheduler.start()` is called. */
  jobs?: ReadonlyMap<string, JobDefinition>;
  /** The time source of the job scheduler (default: the system clock). */
  clock?: JobClock;
  /** The default exports of the enabled features' convention folders (`featureFolders` of `.generated/features.ts`). */
  featureFolders?: FeatureFolderRegistry;
  /** Routes features registered during setup; an endpoint or generated route with the same method and path wins. */
  runtimeRoutes?: readonly RuntimeRoute[];
  /** Middlewares features added during setup with `ctx.app.use`, in feature order. */
  middleware?: readonly OwnedMiddleware[];
  /** Server settings features gave during setup with `ctx.app.configureServer`. */
  server?: ServerSettings;
}

/** The default exports of features' convention folders, by feature key, folder name and file name. */
export type FeatureFolderRegistry = Record<string, Record<string, ReadonlyMap<string, unknown>>>;

export interface App {
  server: Server;
  /** The default exports of the enabled features' convention folders. */
  featureFolders: FeatureFolderRegistry;
  repos: RepositoryRegistry;
  /** Claims, executes and records job runs. */
  jobRunner: JobRunner;
  /**
   * Runs the jobs at their scheduled times when `jobs.enabled`; starting it also starts the run cleanup and the check
   * that marks the runs of stopped instances as abandoned.
   */
  scheduler: JobScheduler;
  /** Deletes the run records past their job's retention, hourly once the scheduler is started. */
  runCleanup: JobRunCleanup;
  /** Marks the runs of stopped instances as abandoned, at startup and once a minute once the scheduler is started. */
  abandonedRuns: AbandonedRunMonitor;
  /**
   * Stops scheduling and claiming runs, aborts the running jobs and waits up to `jobs.shutdownGrace` for them; the
   * ones still running are recorded as `interrupted`.
   */
  shutdown(): Promise<void>;
}

/** Assembles repositories, generated and custom routes and their hooks into a server. */
/**
 * The runtime routes that no endpoint or generated route takes, logging each one an endpoint replaces; fails when two
 * features register the same route or one takes a path of the API docs.
 */
function runtimeRoutesOf(routes: readonly RuntimeRoute[], taken: Route[], logger: Logger): RuntimeRoute[] {
  const key = (route: { method: string; path: string }) => `${route.method.toUpperCase()} ${patternOf(route.path)}`;
  const owners = new Map<string, RuntimeRoute>();
  for (const route of routes) {
    const name = `${route.method.toUpperCase()} ${route.path}`;
    if (route.method.toUpperCase() === "GET" && (patternOf(route.path) === DOCS_PATH || patternOf(route.path) === OPENAPI_PATH)) {
      throw new Error(`Runtime route ${name} of ${route.feature} takes a path reserved for the API docs`);
    }
    const previous = owners.get(key(route));
    if (previous) throw new Error(`Runtime route ${name} is registered by both ${previous.feature} and ${route.feature}`);
    owners.set(key(route), route);
  }
  const takenKeys = new Map(taken.map((route) => [key(route), route]));
  return routes.filter((route) => {
    const winner = takenKeys.get(key(route));
    if (!winner) return true;
    safeLog(logger, "info", {
      timestamp: new Date().toISOString(),
      message: "route.replaced",
      route: `${route.method.toUpperCase()} ${route.path}`,
      feature: route.feature,
      replacedBy: `endpoint ${winner.method.toUpperCase()} ${winner.path}`,
    });
    return false;
  });
}

/** The middlewares of the enabled features (their definitions', then the ones added in setup) and of the project, by stage. */
function stagesOf(config: ResolvedConfig, added: readonly OwnedMiddleware[]): MiddlewareStages | undefined {
  const features = (config.features ?? []).flatMap((feature) => [
    ...(feature.definition.middleware ?? []).map((middleware) => ({ owner: feature.key, middleware })),
    ...added.filter((entry) => entry.owner === feature.key),
  ]);
  if (features.length === 0 && (config.middleware ?? []).length === 0) return undefined;
  return middlewareStages(features, config.middleware ?? []);
}

/** The request properties of the enabled features, failing when a name is taken by the core or by another feature. */
function requestPropertiesOf(config: ResolvedConfig): Map<string, (req: ServiceRequest) => unknown> {
  const properties = new Map<string, (req: ServiceRequest) => unknown>();
  const owners = new Map<string, string>();
  for (const feature of config.features ?? []) {
    for (const [name, factory] of Object.entries(feature.definition.request ?? {})) {
      if ((REQUEST_PROPERTIES as readonly string[]).includes(name)) throw new Error(`Request property ${name} of ${feature.key} conflicts with the built-in request property ${name}`);
      const owner = owners.get(name);
      if (owner) throw new Error(`Request property ${name} of ${feature.key} conflicts with ${owner}`);
      owners.set(name, feature.key);
      properties.set(name, factory);
    }
  }
  return properties;
}

export function createApp({ models, crudRoutes, endpoints: allEndpoints, hooks, config, openApi, jobs: allJobs = new Map(), clock, featureFolders = {}, runtimeRoutes = [], middleware = [], server: settings = {} }: AppOptions): App {
  // Endpoints and jobs of features that are not enabled in this configuration are left out.
  const enabledFeatures = new Set(config.features?.map((feature) => feature.key) ?? []);
  const endpoints = allEndpoints.some((endpoint) => endpoint.feature !== undefined)
    ? allEndpoints.filter((endpoint) => endpoint.feature === undefined || enabledFeatures.has(endpoint.feature))
    : allEndpoints;
  const jobs = [...allJobs.values()].some((definition) => definition.feature !== undefined)
    ? new Map([...allJobs].filter(([, definition]) => definition.feature === undefined || enabledFeatures.has(definition.feature)))
    : allJobs;
  prepareFeatureTargets(models, endpoints, crudRoutes);
  const fileAccess = { storage: config.storage, files: config.files, publicUrl: config.server.publicUrl };
  const fileCleanup = {
    storage: config.storage,
    deleteOnRemove: config.files.deleteOnRemove,
    deleteReplaced: config.files.deleteReplaced,
    deleteWithOwner: config.files.deleteWithOwner,
    logger: config.logger ?? jsonLogger,
  };
  configureTransactions(config.database, config.logger ?? jsonLogger);
  const repos = createRepositories(models, config.database, {
    populateMaxDepth: config.populate?.maxDepth,
    fileAccess,
    fileCleanup,
    findAllMax: config.repositories?.findAllMax,
  });
  const hooksByRoute = new Map(crudRoutes.map((entry) => [`${entry.method} ${entry.path}`, entry.hooks]));
  const uploads = { storage: config.storage, files: config.files };
  // The file route runs the entity's read hooks in proxy mode; a valid signature is the only check in signed mode.
  const hooksOf = (route: CrudRoute): HookCall[] =>
    route.fileAccess === "signed"
      ? []
      : (hooksByRoute.get(`${route.method} ${route.fileAccess ? route.path.replace(/\/file$/, "") : route.path}`) ?? []);
  const generated: Route[] = createCrudRoutes(models, repos, { uploads, fileAccess }).map((route) => ({
    method: route.method,
    path: route.path,
    handler: withHooks(route.handler, hooksOf(route), hooks),
  }));
  const withPopulate = (endpoint: AppEndpoint): Endpoint => {
    const populate = endpoint.populate;
    const handler = withQueryItems(endpoint.handler, endpoint.query);
    const model = populate && models.find((candidate) => candidate.key === populate.entity);
    if (!populate || !model || populate.paths.length === 0) return handler;
    const repository = repositoryFor(repos, model);
    return async (repos, req, res) =>
      populateResult(await handler(repos, req, res), (records) => repository.populate(records, populate.paths)) as never;
  };
  const custom: Route[] = endpoints.map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    handler: withHooks(withProjection(withPopulate(endpoint), endpoint.projection), endpoint.hooks, hooks),
    ...(endpoint.status !== undefined ? { status: endpoint.status } : {}),
  }));
  const docs = openApi && config.docs?.enabled ? docsRoutes(openApi) : [];
  const logger = config.logger ?? jsonLogger;
  const routes = mergeRoutes(generated, custom);
  const runtime: Route[] = runtimeRoutesOf(runtimeRoutes, routes, logger).map((route) => ({
    method: route.method,
    path: route.path,
    handler: withHooks(route.handler, route.hooks, hooks),
  }));
  const jobRunModel = models.find((model) => model.key === "JobRun" && model.system);
  const jobRunner = createJobRunner({
    jobs,
    database: config.database,
    model: jobRunModel,
    repos: repos as unknown as Repositories,
    files: config.storage,
    config: config.jobs,
    production: config.production,
    logger,
    clock,
  });
  const server = createServer({
    routes: [...routes, ...runtime, ...docs],
    repos: repos as unknown as Repositories,
    config,
    jobs: createRequestJobs(jobRunner, { logger, clock }),
    middleware: stagesOf(config, middleware),
    requestProperties: requestPropertiesOf(config),
    ...settings,
  });
  const jobScheduler = createJobScheduler(jobs, jobRunner, { enabled: config.jobs.enabled, logger, clock });
  // Projects without jobs have no run records to clean.
  const runCleanup = createJobRunCleanup({
    jobs,
    database: config.database,
    model: jobRunModel ?? jobRunEntity(),
    config: config.jobs,
    enabled: config.jobs.enabled && jobRunModel !== undefined,
    logger,
    clock,
  });
  const abandonedRuns = createAbandonedRunMonitor(jobRunner, { enabled: config.jobs.enabled && jobRunModel !== undefined && jobs.size > 0, logger, clock });
  const scheduler: JobScheduler = {
    ...jobScheduler,
    start() {
      jobScheduler.start();
      runCleanup.start();
      abandonedRuns.start();
    },
    stop() {
      jobScheduler.stop();
      runCleanup.stop();
      abandonedRuns.stop();
    },
    async idle() {
      await jobScheduler.idle();
      await runCleanup.idle();
    },
  };
  const shutdown = async () => {
    scheduler.stop();
    await jobRunner.shutdown(parseDuration(config.jobs.shutdownGrace) ?? 0);
  };
  return { server, featureFolders, repos, jobRunner, scheduler, runCleanup, abandonedRuns, shutdown };
}
