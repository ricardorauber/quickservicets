import {
  alwaysHiddenPaths,
  entityModel,
  entityRoutePath,
  field,
  HttpError,
  parseListQuery,
  type EntityModel,
  type FieldErrorDetail,
  type OpenApiDoc,
} from "../public.ts";
import type { HistoryVersion } from "./model.ts";
import type { VersionPage, VersionQuery } from "./store.ts";

/** The filters the list of versions accepts, by field. */
const FILTERS: Readonly<Record<string, readonly string[]>> = { operation: ["eq", "in"], at: ["gt", "gte", "lt", "lte"], actor: ["eq", "in"] };

/** The filterable fields of a version, parsed with the list routes' rules. */
const QUERY_MODEL = entityModel("HistoryQuery", {
  operation: field({ type: "enum", values: ["create", "update", "delete"] }),
  at: field({ type: "date" }),
  actor: field({ type: "string" }),
});

const WHERE_KEY = /^where\[([^\]]+)\]\[([^\]]+)\]$/;

/** The query of the versions list: `limit`, `offset` and the filters of `FILTERS`; anything else fails with 400 naming it. */
export function parseVersionQuery(params: URLSearchParams): VersionQuery {
  const details: FieldErrorDetail[] = [];
  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    const where = WHERE_KEY.exec(key);
    if (key === "limit" || key === "offset" || (where && FILTERS[where[1]!]?.includes(where[2]!))) kept.append(key, value);
    else details.push({ field: key, message: "Unknown parameter" });
  }
  if (details.length > 0) throw new HttpError(400, "Invalid query", { details });
  const { where, limit, offset } = parseListQuery(QUERY_MODEL, kept);
  return { where, limit, offset };
}

/** The version number of a route parameter, or a 400 naming `version`. */
export function parseVersionNumber(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HttpError(400, "Invalid version", { details: [{ field: "version", message: "Must be a positive integer" }] });
  }
  return Number(raw);
}

/** Removes a dot path from a value, through nested objects and arrays of objects. */
function removePath(value: unknown, path: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) removePath(item, path);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const [head, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) delete (value as Record<string, unknown>)[head];
  else removePath((value as Record<string, unknown>)[head], rest);
}

/** A version as the routes answer it: the entity's always-hidden paths removed from its record. */
export function versionResponse(version: HistoryVersion, hidden: readonly string[][]): HistoryVersion {
  const record = structuredClone(version.record);
  for (const path of hidden) removePath(record, path);
  const { entityId: _, ...rest } = version;
  return { ...rest, record } as HistoryVersion;
}

/** The always-hidden paths of an entity, split into segments. */
export const hiddenPathsOf = (entity: EntityModel) => alwaysHiddenPaths(entity.fields).map((path) => path.split("."));

/** The paths of an entity's history routes. */
export function historyPaths(entity: EntityModel): { list: string; version: string } {
  const item = `${entityRoutePath(entity)}/[id]`;
  return { list: `${item}/history`, version: `${item}/history/[version]` };
}

/** The list route's answer: a page of versions, or 404 when the record has none. */
export function listAnswer(entity: EntityModel, page: VersionPage, query: VersionQuery, hidden: readonly string[][], anyVersion: boolean) {
  if (!anyVersion) throw new HttpError(404, `${entity.entityName} not found`);
  return { data: page.data.map((version) => versionResponse(version, hidden)), total: page.total, limit: query.limit, offset: query.offset };
}

type Operation = { tags?: string[]; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> };

const ERROR = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

/** Documents both history routes of each entity in `/openapi.json`, with a `<Entity>Version` schema. */
export function documentHistory(doc: OpenApiDoc, entities: readonly EntityModel[]): OpenApiDoc {
  for (const entity of entities) {
    const collection = entityRoutePath(entity);
    const read = (doc.paths[`${collection}/{id}`] as Record<string, Operation> | undefined)?.get;
    if (!read) continue;
    const recordSchema = read.responses?.["200"]?.content?.["application/json"]?.schema ?? { type: "object" };
    const name = `${entity.entityName}Version`;
    doc.components ??= {};
    const schemas = (doc.components.schemas ??= {});
    schemas[name] = {
      type: "object",
      required: ["version", "operation", "actor", "at", "record", "changed"],
      properties: {
        version: { type: "integer", minimum: 1 },
        operation: { type: "string", enum: ["create", "update", "delete"] },
        actor: { type: "string", description: "user:<id>, job:<name>, queue:<name> or system." },
        tenant: { type: "string" },
        requestId: { type: "string" },
        at: { type: "string", format: "date-time" },
        record: recordSchema,
        changed: { type: "array", items: { type: "string" } },
      },
    };
    const versionRef = { $ref: `#/components/schemas/${name}` };
    const tags = read.tags ?? [];
    const idParameter = { name: "id", in: "path", required: true, schema: { type: "string" } };
    doc.paths[`${collection}/{id}/history`] = {
      get: {
        tags,
        operationId: `listHistory${entity.entityName}`,
        summary: `The versions of a ${entity.entityName}, newest first`,
        parameters: [
          idParameter,
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          { name: "where[operation][eq]", in: "query", schema: { type: "string", enum: ["create", "update", "delete"] } },
          { name: "where[operation][in]", in: "query", description: "Comma-separated operations.", schema: { type: "string" } },
          ...["gt", "gte", "lt", "lte"].map((op) => ({ name: `where[at][${op}]`, in: "query", schema: { type: "string", format: "date-time" } })),
          { name: "where[actor][eq]", in: "query", schema: { type: "string" } },
          { name: "where[actor][in]", in: "query", description: "Comma-separated actors.", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: `A page of the versions of a ${entity.entityName}`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "total", "limit", "offset"],
                  properties: { data: { type: "array", items: versionRef }, total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } },
                },
              },
            },
          },
          "400": ERROR("Invalid query"),
          "404": ERROR("The record has no versions"),
        },
      },
    };
    doc.paths[`${collection}/{id}/history/{version}`] = {
      get: {
        tags,
        operationId: `readHistory${entity.entityName}`,
        summary: `One version of a ${entity.entityName}`,
        parameters: [idParameter, { name: "version", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: {
          "200": { description: `The version of the ${entity.entityName}`, content: { "application/json": { schema: versionRef } } },
          "400": ERROR("Invalid version"),
          "404": ERROR("The version does not exist"),
        },
      },
    };
  }
  return doc;
}
