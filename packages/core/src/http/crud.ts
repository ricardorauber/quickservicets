import { HttpError } from "../errors.ts";
import { entityRoutePath, type CrudOperation, type EntityModel } from "../model.ts";
import { parseListQuery } from "../query.ts";
import { repositoryFor, type RepositoryRegistry } from "../repository.ts";
import { patternOf } from "./router.ts";
import { parseClientSelection, selectFields } from "./selection.ts";
import type { Endpoint, Route } from "./server.ts";

export interface CrudRoute extends Route {
  entity: EntityModel;
  operation: CrudOperation;
}

export function createCrudRoutes(models: EntityModel[], repos: RepositoryRegistry): CrudRoute[] {
  return models
    .filter((model) => !model.internal)
    .flatMap((model) => {
      const repo = repositoryFor(repos, model);
      const collection = entityRoutePath(model);
      const item = `${collection}/[id]`;
      const id = (params: Record<string, string>) => params.id!;

      const handlers: [string, string, CrudOperation, Endpoint][] = [
        [
          "GET",
          collection,
          "list",
          async (_, req) => {
            const selection = parseClientSelection(model, "list", req.query);
            const result = await repo.list(parseListQuery(model, req.query));
            return { ...result, data: result.data.map((record) => selectFields(record, model.exposure.list, selection)) };
          },
        ],
        [
          "GET",
          item,
          "read",
          async (_, req) => {
            const selection = parseClientSelection(model, "read", req.query);
            const record = await repo.findById(id(req.params));
            if (!record) throw new HttpError(404, `${model.entityName} not found`);
            return selectFields(record, model.exposure.read, selection);
          },
        ],
        [
          "POST",
          collection,
          "create",
          async (_, req, res) => {
            const created = await repo.create(await req.json());
            res.status(201);
            return created;
          },
        ],
        ["PATCH", item, "update", async (_, req) => repo.update(id(req.params), await req.json())],
        ["PUT", item, "replace", async (_, req) => repo.replace(id(req.params), await req.json())],
        [
          "DELETE",
          item,
          "delete",
          async (_, req) => {
            await repo.delete(id(req.params));
            return undefined;
          },
        ],
      ];
      return handlers.map(([method, path, operation, handler]) => ({ method, path, handler, entity: model, operation }));
    });
}

/** Combines generated and custom routes; a custom route with the same method and pattern replaces the generated one. */
export function mergeRoutes<G extends Route, C extends Route>(generated: G[], custom: C[]): (G | C)[] {
  const key = (route: Route) => `${route.method.toUpperCase()} ${patternOf(route.path)}`;
  const overridden = new Set(custom.map(key));
  return [...generated.filter((route) => !overridden.has(key(route))), ...custom];
}
