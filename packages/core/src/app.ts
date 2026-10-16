import type { ResolvedConfig } from "./config.ts";
import type { HookCall, HookDefinition, Repositories } from "./hooks.ts";
import { createCrudRoutes, mergeRoutes } from "./http/crud.ts";
import { withHooks } from "./http/pipeline.ts";
import { createServer, type Endpoint, type Route, type Server } from "./http/server.ts";
import type { CrudOperation, EntityModel } from "./model.ts";
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
}

export interface App {
  server: Server;
  repos: RepositoryRegistry;
}

/** Assembles repositories, generated and custom routes and their hooks into a server. */
export function createApp({ models, crudRoutes, endpoints, hooks, config }: AppOptions): App {
  const repos = createRepositories(models, config.database, { populateMaxDepth: config.populate?.maxDepth });
  const hooksByRoute = new Map(crudRoutes.map((entry) => [`${entry.method} ${entry.path}`, entry.hooks]));
  const uploads = { storage: config.storage, files: config.files };
  const generated: Route[] = createCrudRoutes(models, repos, { uploads }).map((route) => ({
    method: route.method,
    path: route.path,
    handler: withHooks(route.handler, hooksByRoute.get(`${route.method} ${route.path}`) ?? [], hooks),
  }));
  const withPopulate = (endpoint: AppEndpoint): Endpoint => {
    const populate = endpoint.populate;
    const model = populate && models.find((candidate) => candidate.key === populate.entity);
    if (!populate || !model || populate.paths.length === 0) return endpoint.handler;
    const repository = repositoryFor(repos, model);
    return async (repos, req, res) =>
      populateResult(await endpoint.handler(repos, req, res), (records) => repository.populate(records, populate.paths)) as never;
  };
  const custom: Route[] = endpoints.map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    handler: withHooks(withProjection(withPopulate(endpoint), endpoint.projection), endpoint.hooks, hooks),
  }));
  const server = createServer({ routes: mergeRoutes(generated, custom), repos: repos as unknown as Repositories, config });
  return { server, repos };
}
