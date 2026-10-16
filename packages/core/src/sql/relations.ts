import { asc, eq, inArray } from "drizzle-orm";
import type { StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import { junctionKey, type DrizzleSchema } from "./schema.ts";

// Tables are built at runtime from the models, so Drizzle cannot type their columns statically.
type Executor = any;

const run = async (query: any, dialect: DrizzleSchema["dialect"]) => (dialect === "sqlite" ? query.all() : await query);

export const relationFields = (entity: EntityModel) => entity.fields.filter((field) => field.storage === "relation");

/** Splits a record into the entity's own columns and its reference arrays. */
export function splitRelations(entity: EntityModel, values: Record<string, unknown>) {
  const columns: Record<string, unknown> = {};
  const relations: Record<string, string[]> = {};
  const names = new Set(relationFields(entity).map((field) => field.name));
  for (const [key, value] of Object.entries(values)) {
    if (names.has(key)) relations[key] = Array.isArray(value) ? (value as string[]) : [];
    else columns[key] = value;
  }
  return { columns, relations };
}

/** Loads every reference array of `records` with one query per field, ordered by position. */
export async function loadRelations(
  db: Executor,
  schema: DrizzleSchema,
  entity: EntityModel,
  records: StoredRecord[],
): Promise<StoredRecord[]> {
  const fields = relationFields(entity);
  if (fields.length === 0 || records.length === 0) return records;
  const result = records.map((record) => ({ ...record }));
  const ids = result.map((record) => record.id);
  for (const field of fields) {
    const junction = schema.junctions[junctionKey(entity.key, field.name)] as any;
    const rows = (await run(
      db
        .select({ ownerId: junction.ownerId, targetId: junction.targetId })
        .from(junction)
        .where(inArray(junction.ownerId, ids))
        .orderBy(asc(junction.ownerId), asc(junction.position)),
      schema.dialect,
    )) as { ownerId: string; targetId: string }[];
    const byOwner = new Map<string, string[]>();
    for (const row of rows) byOwner.set(row.ownerId, [...(byOwner.get(row.ownerId) ?? []), row.targetId]);
    for (const record of result) record[field.name] = byOwner.get(record.id) ?? [];
  }
  return result;
}

/** Replaces the junction rows of the given reference arrays of one owner. */
export async function writeRelations(
  db: Executor,
  schema: DrizzleSchema,
  entity: EntityModel,
  ownerId: string,
  relations: Record<string, string[]>,
): Promise<void> {
  for (const [field, targets] of Object.entries(relations)) {
    const junction = schema.junctions[junctionKey(entity.key, field)] as any;
    const remove = db.delete(junction).where(eq(junction.ownerId, ownerId));
    await (schema.dialect === "sqlite" ? remove.run() : remove);
    if (targets.length > 0) {
      const insert = db.insert(junction).values(targets.map((targetId, position) => ({ ownerId, targetId, position })));
      await (schema.dialect === "sqlite" ? insert.run() : insert);
    }
  }
}
