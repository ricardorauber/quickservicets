import { splitWords, toCamelCase, toSnakeCase, type EntityModel, type FieldModel, type StoredRecord } from "../public.ts";

/** Which entities keep history: only those tagged `@history`, or every regular entity. */
export type HistoryCoverage = "tagged" | "all";

/** The operations of versions. */
export type HistoryOperation = "create" | "update" | "delete";

/** One version of a record, as the history tables store it. */
export interface HistoryVersion {
  /** The id of the versioned record. */
  entityId: string;
  /** 1 for the first version of a record, one more for each later one. */
  version: number;
  operation: HistoryOperation;
  /** `user:<id>`, `job:<name>`, `queue:<name>` or `system`. */
  actor: string;
  tenant?: string;
  requestId?: string;
  at: Date;
  /** The record after the write (before it, for a delete), without the fields history leaves out. */
  record: Record<string, unknown>;
  /** The top-level fields the write changed. */
  changed: string[];
}

/**
 * Whether an entity keeps history: `@history` covers it and `@history off` excludes it; with `all`, every entity that
 * is not a system, link or `@internal` entity is covered unless it says `@history off`.
 */
export function isCovered(entity: EntityModel, coverage: HistoryCoverage): boolean {
  const tag = entity.tags?.history;
  if (tag) return tag.on;
  if (coverage !== "all") return false;
  return !entity.system && !entity.link && !entity.internal;
}

/** The entities of a model that keep history, without the history models themselves. */
export function coveredEntities(models: readonly EntityModel[], coverage: HistoryCoverage): EntityModel[] {
  return models.filter((entity) => entity.feature !== "history" && isCovered(entity, coverage));
}

/** The key of an entity's history model: `User` → `UserHistory`. */
export const historyModelKey = (entity: Pick<EntityModel, "entityName">) => `${entity.entityName}History`;

/** The derived history model of an entity: a read-only system entity named `<Entity>History`. */
export function historyModel(entity: EntityModel): EntityModel {
  // `OrderItem` → `order-item-history`, stored as `order_item_history` and reached as `repos.orderItemHistory`.
  const collection = `${splitWords(entity.entityName).map((word) => word.toLowerCase()).join("-")}-history`;
  const fields = [
    { name: "entityId", type: "string", optional: false, storage: "column" },
    { name: "version", type: "number", integer: true, min: 1, optional: false, storage: "column" },
    { name: "operation", type: "enum", values: ["create", "update", "delete"], optional: false, storage: "column" },
    { name: "actor", type: "string", optional: false, storage: "column" },
    { name: "tenant", type: "string", optional: true, storage: "column" },
    { name: "requestId", type: "string", optional: true, storage: "column" },
    { name: "at", type: "date", optional: false, storage: "column" },
    { name: "record", type: "json", optional: false, storage: "json" },
    { name: "changed", type: "array", items: { type: "string" }, optional: false, storage: "json" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  const key = historyModelKey(entity);
  return {
    key,
    entityName: key,
    schema: entity.schema,
    ...(entity.schemaKey ? { schemaKey: entity.schemaKey } : {}),
    name: collection,
    repoKey: toCamelCase(collection),
    tableName: toSnakeCase(collection),
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["entityId", "version"], unique: true }, { fields: ["entityId", "at"] }],
    system: true,
    derivedFrom: entity.key,
  };
}

/** The history models of the covered entities of a model. */
export function historyModels(models: readonly EntityModel[], coverage: HistoryCoverage): EntityModel[] {
  return coveredEntities(models, coverage).map(historyModel);
}

const tagOf = (field: FieldModel, name: string) => field.tags?.[name];

/**
 * The top-level fields history leaves out of an entity's records: those tagged `@history off`, and those tagged
 * `@hidden` or `@sensitive` unless they are tagged `@history on`.
 */
export function excludedFields(entity: EntityModel): string[] {
  return entity.fields
    .filter((field) => {
      const history = tagOf(field, "history");
      if (history) return !history.on;
      return field.hidden === true || tagOf(field, "sensitive")?.on === true;
    })
    .map((field) => field.name);
}

/** A record as a version keeps it: a JSON copy without the excluded fields. */
export function snapshotOf(record: StoredRecord, excluded: readonly string[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  for (const name of excluded) delete copy[name];
  return copy;
}
