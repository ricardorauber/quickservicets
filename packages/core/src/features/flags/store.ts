import { entityModel, field, type DatabaseAdapter, type EntityModel, type StoredRecord } from "../public.ts";
import type { FlagRule } from "./evaluate.ts";

/** The fields of `FeatureFlag` the native reads and writes, with their types. */
export const FEATURE_FLAG_FIELDS = {
  name: field({ type: "string", unique: true }),
  enabled: field({ type: "boolean", default: true }),
  users: field({ type: "array", items: { type: "string" }, optional: true }),
  tenants: field({ type: "array", items: { type: "string" }, optional: true }),
  percentage: field({ type: "number", integer: true, min: 0, max: 100, optional: true }),
  description: field({ type: "string", optional: true }),
};

/** The internal entity of the database source: one row per flag changed at runtime, writable from code, without routes. */
export function featureFlagEntity(): EntityModel {
  return entityModel("FeatureFlag", FEATURE_FLAG_FIELDS, { internal: true });
}

/** A stored row as a rule. */
export function ruleOfRow(row: Record<string, unknown>): FlagRule {
  return {
    enabled: row.enabled !== false,
    ...(Array.isArray(row.users) ? { users: (row.users as unknown[]).map(String) } : {}),
    ...(Array.isArray(row.tenants) ? { tenants: (row.tenants as unknown[]).map(String) } : {}),
    ...(typeof row.percentage === "number" ? { percentage: row.percentage } : {}),
    ...(typeof row.description === "string" ? { description: row.description } : {}),
  };
}

/** Every row of the table, by flag name. */
export async function loadFlagRows(adapter: DatabaseAdapter, model: EntityModel): Promise<Map<string, FlagRule>> {
  const rows = new Map<string, FlagRule>();
  for (let offset = 0; ; offset += 1000) {
    const { data } = await adapter.findMany(model, { where: [], sort: [{ field: "name", direction: "asc" }], limit: 1000, offset, withTotal: false });
    for (const row of data as StoredRecord[]) rows.set(String(row.name), ruleOfRow(row));
    if (data.length < 1000) return rows;
  }
}
