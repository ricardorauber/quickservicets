import type { DatabaseAdapter, StoredRecord } from "./adapter.ts";
import { HttpError, type FieldErrorDetail } from "./errors.ts";
import { alwaysHiddenPaths, type EntityModel, type FieldModel } from "./model.ts";
import { project } from "./projection.ts";
import { deriveRelations } from "./relations.ts";

/** Reasons a populate path is invalid, or an empty list when it is valid. */
export function populatePathErrors(model: EntityModel, models: EntityModel[], path: string, maxDepth: number): string[] {
  const segments = path.split(".");
  if (segments.length > maxDepth) return [`Populate depth exceeds ${maxDepth}`];
  let current: EntityModel | undefined = model;
  for (const segment of segments) {
    const field: FieldModel | undefined = current?.fields.find((candidate) => candidate.name === segment);
    if (!field || (field.type !== "ref" && field.type !== "refArray")) return [`Cannot populate: ${path}`];
    const target: string = field.target;
    current = models.find((candidate) => candidate.key === target);
  }
  return [];
}

/** Validates populate paths, failing with 400 VALIDATION_ERROR on the `populate` parameter. */
export function assertPopulatePaths(model: EntityModel, models: EntityModel[], paths: string[], maxDepth: number): void {
  const details: FieldErrorDetail[] = paths.flatMap((path) =>
    populatePathErrors(model, models, path, maxDepth).map((message) => ({ field: "populate", message })),
  );
  if (details.length > 0) throw new HttpError(400, details[0]!.message, { details });
}

export function parsePopulateParam(params: URLSearchParams): string[] {
  const raw = params.get("populate");
  if (raw === null) return [];
  return raw.split(",").map((path) => path.trim()).filter((path) => path !== "");
}

type PathTree = Map<string, PathTree>;

function toTree(paths: string[]): PathTree {
  const root: PathTree = new Map();
  for (const path of paths) {
    let node = root;
    for (const segment of path.split(".")) {
      if (!node.has(segment)) node.set(segment, new Map());
      node = node.get(segment)!;
    }
  }
  return root;
}

/** How a referenced record appears when populated: hidden fields removed and the target's read exposure applied. */
function presentPopulated(target: EntityModel, record: StoredRecord): unknown {
  return project(project(record, { exclude: alwaysHiddenPaths(target.fields) }), target.exposure.read);
}

/**
 * Replaces reference ids with the referenced records, loading each reference path with one batched query.
 * Missing referenced records become null.
 */
export async function populateRecords(
  model: EntityModel,
  records: StoredRecord[],
  paths: string[],
  models: EntityModel[],
  adapter: DatabaseAdapter,
  /** Adds computed fields (e.g. file URLs) to the loaded referenced records. */
  compute: (entity: EntityModel, records: StoredRecord[]) => Promise<StoredRecord[]> = async (_, records) => records,
): Promise<StoredRecord[]> {
  const fill = async (entity: EntityModel, items: StoredRecord[], tree: PathTree): Promise<StoredRecord[]> => {
    const result = items.map((item) => ({ ...item }));
    for (const [fieldName, subtree] of tree) {
      const field = entity.fields.find((candidate) => candidate.name === fieldName);
      if (!field || (field.type !== "ref" && field.type !== "refArray")) continue;
      const target = models.find((candidate) => candidate.key === field.target);
      if (!target) continue;
      const referenced = result.flatMap((item) => {
        const value = item[fieldName];
        return Array.isArray(value) ? value : [value];
      });
      const ids = [...new Set(referenced.filter((id): id is string => typeof id === "string"))];
      const found =
        ids.length === 0
          ? []
          : (
              await adapter.findMany(target, {
                where: [{ field: "id", op: "in", value: ids }],
                sort: [{ field: "id", direction: "asc" }],
                limit: ids.length,
                offset: 0,
              })
            ).data;
      const withDerived = await compute(target, await deriveRelations(target, found, models, adapter));
      const nested = subtree.size > 0 ? await fill(target, withDerived, subtree) : withDerived;
      const byId = new Map(nested.map((record) => [record.id, presentPopulated(target, record)]));
      for (const item of result) {
        const value = item[fieldName];
        if (Array.isArray(value)) {
          // Arrays keep their stored order and drop ids whose records no longer exist.
          item[fieldName] = value.flatMap((id) => (byId.has(id as string) ? [byId.get(id as string)] : []));
        } else if (typeof value === "string") {
          item[fieldName] = byId.get(value) ?? null;
        }
      }
    }
    return result;
  };
  return paths.length === 0 ? records : fill(model, records, toTree(paths));
}
