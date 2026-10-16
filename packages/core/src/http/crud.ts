import { HttpError } from "../errors.ts";
import { entityRoutePath, type CrudOperation, type EntityModel } from "../model.ts";
import { parseListQuery } from "../query.ts";
import { repositoryFor, type RepositoryRegistry } from "../repository.ts";
import { patternOf } from "./router.ts";
import { parseClientSelection, selectFields } from "./selection.ts";
import { parsePopulateParam } from "../populate.ts";
import { parseUpload, storeFile, type UploadSettings } from "../files/upload.ts";
import type { Endpoint, Route } from "./server.ts";

export interface CrudRoute extends Route {
  entity: EntityModel;
  operation: CrudOperation;
}

/** Default `@populate` paths of an operation plus the request's `populate` parameter. */
export function populatePaths(model: EntityModel, operation: "list" | "read", params: URLSearchParams): string[] {
  return [...new Set([...(model.populate?.[operation] ?? []), ...parsePopulateParam(params)])];
}

export interface CrudOptions {
  /** Storages and limits used by uploads to file entities. */
  uploads?: UploadSettings;
}

/** Runs `write` with a freshly stored file, removing the stored object when the write fails. */
async function withStoredFile<T>(
  model: EntityModel,
  id: string,
  file: Blob & { name?: string },
  uploads: UploadSettings,
  write: (managed: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const stored = await storeFile(model, id, file, uploads);
  try {
    return await write(stored.managed);
  } catch (error) {
    await stored.discard();
    throw error;
  }
}

export function createCrudRoutes(models: EntityModel[], repos: RepositoryRegistry, options: CrudOptions = {}): CrudRoute[] {
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
            const populate = populatePaths(model, "list", req.query);
            const selection = parseClientSelection(model, "list", req.query, { populated: populate, models });
            const result = await repo.list(parseListQuery(model, req.query), { populate });
            return { ...result, data: result.data.map((record) => selectFields(record, model.exposure.list, selection)) };
          },
        ],
        [
          "GET",
          item,
          "read",
          async (_, req) => {
            const populate = populatePaths(model, "read", req.query);
            const selection = parseClientSelection(model, "read", req.query, { populated: populate, models });
            const record = await repo.findById(id(req.params), { populate });
            if (!record) throw new HttpError(404, `${model.entityName} not found`);
            return selectFields(record, model.exposure.read, selection);
          },
        ],
        [
          "POST",
          collection,
          "create",
          async (_, req, res) => {
            let created: unknown;
            if (model.file) {
              const uploads = options.uploads!;
              const { file, data } = await parseUpload(req, model, uploads);
              const newId = Bun.randomUUIDv7();
              created = await withStoredFile(model, newId, file, uploads, (managed) => repo.createWith(newId, managed, data));
            } else {
              created = await repo.create(await req.json());
            }
            res.status(201);
            return created;
          },
        ],
        ["PATCH", item, "update", async (_, req) => repo.update(id(req.params), await req.json())],
        [
          "PUT",
          item,
          "replace",
          async (_, req) => {
            if (!model.file) return repo.replace(id(req.params), await req.json());
            const uploads = options.uploads!;
            const { file, data } = await parseUpload(req, model, uploads);
            return withStoredFile(model, id(req.params), file, uploads, (managed) => repo.replaceWith(id(req.params), managed, data));
          },
        ],
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
