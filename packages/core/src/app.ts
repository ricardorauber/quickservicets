import type { ResolvedConfig } from "./config.ts";
import type { HookCall, HookDefinition, Repositories } from "./hooks.ts";
import { createCrudRoutes, mergeRoutes } from "./http/crud.ts";
import { withHooks } from "./http/pipeline.ts";
import { createServer, type Endpoint, type Route, type Server } from "./http/server.ts";
import type { CrudOperation, EntityModel } from "./model.ts";
import { projectResult, type Projection } from "./projection.ts";
import { createRepositories, type RepositoryRegistry } from "./repository.ts";

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
  handler: Endpoint;
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
  const repos = createRepositories(models, config.database);
  const hooksByRoute = new Map(crudRoutes.map((entry) => [`${entry.method} ${entry.path}`, entry.hooks]));
  const generated: Route[] = createCrudRoutes(models, repos).map((route) => ({
    method: route.method,
    path: route.path,
    handler: withHooks(route.handler, hooksByRoute.get(`${route.method} ${route.path}`) ?? [], hooks),
  }));
  const custom: Route[] = endpoints.map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    handler: withHooks(withProjection(endpoint.handler, endpoint.projection), endpoint.hooks, hooks),
  }));
  const server = createServer({ routes: mergeRoutes(generated, custom), repos: repos as unknown as Repositories, config });
  return { server, repos };
}
