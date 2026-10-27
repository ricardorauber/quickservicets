import { HttpError } from "../errors.ts";
import { rememberStoredRecord } from "./stored-records.ts";
import { writeConditionOf } from "./write-conditions.ts";
import { entityRoutePath, vectorFields, type CrudOperation, type EntityModel } from "../model.ts";
import { parseListQuery } from "../query.ts";
import { repositoryLookup, type Repository, type RepositoryRegistry } from "../repository.ts";
import { patternOf } from "./router.ts";
import { parseClientSelection, selectFields, type ClientSelection } from "./selection.ts";
import { parsePopulateParam } from "../populate.ts";
import { parseUpload, storeFile, type UploadSettings } from "../files/upload.ts";
import { isMultipart, parseEntityUpload, withUploadedFiles, type UploadMode } from "../files/references.ts";
import { fileResponse, resolveFileAccess, verifyFileSignature, type FileAccessSettings } from "../files/access.ts";
import type { Endpoint, Route } from "./server.ts";
import type { ServiceRequest } from "../hooks.ts";
import type { StoredRecord } from "../adapter.ts";

export interface CrudRoute extends Route {
  entity: EntityModel;
  operation: CrudOperation;
  /** Set on the route that serves a file entity's bytes, with the entity's access mode. */
  fileAccess?: "proxy" | "signed";
}

/** Default `@populate` paths of an operation plus the request's `populate` parameter. */
export function populatePaths(model: EntityModel, operation: "list" | "read", params: URLSearchParams): string[] {
  return [...new Set([...(model.populate?.[operation] ?? []), ...parsePopulateParam(params)])];
}

/** Vector fields the selection does not ask for: they are neither read nor returned. */
function unselectedVectors(vectors: readonly string[], selection: ClientSelection): string[] {
  if (vectors.length === 0) return vectors as string[];
  return vectors.filter((name) => !selection.fields?.some((path) => path === name || path.startsWith(`${name}.`)));
}

function withoutFields<T>(record: T, fields: readonly string[]): T {
  if (fields.length === 0 || !record || typeof record !== "object") return record;
  const copy = { ...(record as Record<string, unknown>) };
  for (const field of fields) delete copy[field];
  return copy as T;
}

export interface CrudOptions {
  /** Storages and limits used by uploads to file entities. */
  uploads?: UploadSettings;
  /** Access settings of file entities; without them, no file route is generated. */
  fileAccess?: FileAccessSettings;
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

/**
 * The generated routes of the entities. Each handler uses the repository registry it receives with the request (so a
 * request may use the repositories of another database or schema), looked up through a path computed here; `_repos`
 * is no longer read and stays for callers that pass it.
 */
export function createCrudRoutes(models: EntityModel[], _repos?: RepositoryRegistry, options: CrudOptions = {}): CrudRoute[] {
  return models
    .filter((model) => !model.internal)
    .flatMap((model) => {
      const repoOf = repositoryLookup(model);
      const asRegistry = (repos: unknown) => repos as RepositoryRegistry;
      const vectors = vectorFields(model).map((field) => field.name);
      const collection = entityRoutePath(model);
      const item = `${collection}/[id]`;
      const id = (params: Record<string, string>) => params.id!;
      /** Keeps a written record for the features that read it (entity tags), and returns it. */
      const remembered = <T>(req: ServiceRequest, record: T): T => {
        rememberStoredRecord(req, model, record as StoredRecord);
        return record;
      };
      // Regular entities take JSON, or multipart with file parts for their references to file entities.
      const writeBody = async <T>(repos: RepositoryRegistry, req: ServiceRequest, mode: UploadMode, write: (data: unknown) => Promise<T>): Promise<T> => {
        if (!isMultipart(req)) return write(await req.json());
        const uploads = options.uploads!;
        return withUploadedFiles(await parseEntityUpload(req, model, models, uploads), repos, uploads, mode, write);
      };

      const handlers: [string, string, CrudOperation, Endpoint][] = [
        [
          "GET",
          collection,
          "list",
          async (repos, req) => {
            const repo = repoOf(asRegistry(repos));
            const populate = populatePaths(model, "list", req.query);
            const selection = parseClientSelection(model, "list", req.query, { populated: populate, models });
            const omit = unselectedVectors(vectors, selection);
            const result = await repo.list(parseListQuery(model, req.query), omit.length > 0 ? { populate, omit } : { populate });
            return { ...result, data: result.data.map((record) => selectFields(withoutFields(record, omit), model.exposure.list, selection)) };
          },
        ],
        [
          "GET",
          item,
          "read",
          async (repos, req) => {
            const repo = repoOf(asRegistry(repos));
            const populate = populatePaths(model, "read", req.query);
            const selection = parseClientSelection(model, "read", req.query, { populated: populate, models });
            const omit = unselectedVectors(vectors, selection);
            const record = await repo.findById(id(req.params), omit.length > 0 ? { populate, omit } : { populate });
            if (!record) throw new HttpError(404, `${model.entityName} not found`);
            rememberStoredRecord(req, model, record as StoredRecord);
            return selectFields(withoutFields(record, omit), model.exposure.read, selection);
          },
        ],
        [
          "POST",
          collection,
          "create",
          async (repos, req, res) => {
            const repo = repoOf(asRegistry(repos));
            let created: unknown;
            if (model.file) {
              const uploads = options.uploads!;
              const { file, data } = await parseUpload(req, model, uploads);
              const newId = Bun.randomUUIDv7();
              created = await withStoredFile(model, newId, file, uploads, (managed) => repo.createWith(newId, managed, data));
            } else {
              created = await writeBody(asRegistry(repos), req, "create", (data) => repo.create(data));
            }
            res.status(201);
            rememberStoredRecord(req, model, created as StoredRecord);
            return created;
          },
        ],
        [
          "PATCH",
          item,
          "update",
          async (repos, req) => {
            const repo = repoOf(asRegistry(repos));
            const condition = await writeConditionOf(req, model);
            return remembered(req, await writeBody(asRegistry(repos), req, "patch", (data) => repo.update(id(req.params), data, condition)));
          },
        ],
        [
          "PUT",
          item,
          "replace",
          async (repos, req) => {
            const repo = repoOf(asRegistry(repos));
            if (!model.file) {
              const condition = await writeConditionOf(req, model);
              return remembered(req, await writeBody(asRegistry(repos), req, "replace", (data) => repo.replace(id(req.params), data, condition)));
            }
            const uploads = options.uploads!;
            const { file, data } = await parseUpload(req, model, uploads);
            return remembered(req, await withStoredFile(model, id(req.params), file, uploads, (managed) => repo.replaceWith(id(req.params), managed, data)));
          },
        ],
        [
          "DELETE",
          item,
          "delete",
          async (repos, req) => {
            await repoOf(asRegistry(repos)).delete(id(req.params), await writeConditionOf(req, model));
            return undefined;
          },
        ],
      ];
      const routes: CrudRoute[] = handlers.map(([method, path, operation, handler]) => ({ method, path, handler, entity: model, operation }));
      const fileRoute = model.file && options.fileAccess ? createFileRoute(model, repoOf, options.fileAccess) : undefined;
      return fileRoute ? [...routes, fileRoute] : routes;
    });
}

const invalidSignature = () => new HttpError(403, "Invalid or expired signature");

/** `GET <item>/file`, streaming the object in proxy and signed modes; direct mode has no such route. */
function createFileRoute(model: EntityModel, repoOf: (registry: RepositoryRegistry) => Repository, settings: FileAccessSettings): CrudRoute | undefined {
  const { mode } = resolveFileAccess(model, settings);
  if (mode === "direct") return undefined;
  const handler: Endpoint = async (repos, req) => {
    const record = await repoOf(repos as unknown as RepositoryRegistry).findById(req.params.id!, { includeHidden: true });
    if (mode === "signed") {
      const now = (settings.now ?? Date.now)();
      const valid =
        record !== null &&
        verifyFileSignature(
          settings.files.signingSecret ?? "",
          record.id,
          record.storageKey as string,
          req.query.get("expires"),
          req.query.get("signature"),
          now,
        );
      if (!valid) throw invalidSignature();
    }
    if (!record) throw new HttpError(404, `${model.entityName} not found`);
    return fileResponse(model, record, settings);
  };
  return { method: "GET", path: `${entityRoutePath(model)}/[id]/file`, handler, entity: model, operation: "read", fileAccess: mode };
}

/** Combines generated and custom routes; a custom route with the same method and pattern replaces the generated one. */
export function mergeRoutes<G extends Route, C extends Route>(generated: G[], custom: C[]): (G | C)[] {
  const key = (route: Route) => `${route.method.toUpperCase()} ${patternOf(route.path)}`;
  const overridden = new Set(custom.map(key));
  return [...generated.filter((route) => !overridden.has(key(route))), ...custom];
}
