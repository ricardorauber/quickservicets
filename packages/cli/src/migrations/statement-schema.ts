import { buildDrizzleSchema, schemaIdentifier, SQLITE_DEFAULT_SCHEMA_TOKEN, type EntityModel, type SqlDialect } from "@quickservicets/core";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import type { DrizzleSnapshot } from "./snapshot.ts";

/** Finds the explicit schema whose table a generated statement changes, or undefined for default-schema tables. */
export type StatementSchemaResolver = (statement: string) => string | undefined;

const SCHEMA_STATEMENT = /^\s*(?:CREATE|DROP)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"([^"]+)"/i;
const SQLITE_REBUILD_PREFIX = "__new_";

/**
 * Builds a resolver from the models and drizzle snapshots on both sides of a diff. The first identifier of a
 * statement names what it changes: a table, an index, or (on PostgreSQL) a schema-qualified table.
 */
export function statementSchemaResolver(
  dialect: SqlDialect,
  models: EntityModel[][],
  snapshots: DrizzleSnapshot[],
): StatementSchemaResolver {
  const names = new Map<string, string>();
  for (const model of models.flat()) if (model.schema) names.set(schemaIdentifier(model.schema), model.schema);
  if (names.size === 0) return () => undefined;
  // Longest identifiers first, so `billing_eu__` is not taken for `billing__`.
  const identifiers = [...names.keys()].sort((a, b) => b.length - a.length);

  const tableSchema = (table: { name: string; schema?: unknown }): string | undefined => {
    if (dialect === "postgres") return typeof table.schema === "string" && table.schema ? names.get(table.schema) : undefined;
    if (table.name.startsWith(SQLITE_DEFAULT_SCHEMA_TOKEN)) return undefined;
    const identifier = identifiers.find((candidate) => table.name.startsWith(`${candidate}__`));
    return identifier ? names.get(identifier) : undefined;
  };

  const objects = new Map<string, string>();
  for (const snapshot of snapshots) {
    for (const table of Object.values(snapshot.tables)) {
      const schema = tableSchema(table);
      if (!schema) continue;
      if (dialect === "sqlite") objects.set(table.name, schema);
      for (const [key, index] of Object.entries(table.indexes)) objects.set((index as { name?: string }).name ?? key, schema);
    }
  }

  if (dialect === "postgres") {
    return (statement) => {
      const schemaStatement = SCHEMA_STATEMENT.exec(statement);
      if (schemaStatement) return names.get(schemaStatement[1]!);
      const first = /"([^"]+)"(\s*\.\s*")?/.exec(statement);
      if (!first) return undefined;
      return first[2] ? names.get(first[1]!) : objects.get(first[1]!);
    };
  }
  return (statement) => {
    const first = /`([^`]+)`/.exec(statement)?.[1];
    if (!first) return undefined;
    const name = first.startsWith(SQLITE_REBUILD_PREFIX) ? first.slice(SQLITE_REBUILD_PREFIX.length) : first;
    return objects.get(name) ?? tableSchema({ name });
  };
}

/**
 * Tells whether a generated statement changes a table (or an index of one) of a shared default-schema model, which
 * with tenancy lives once in the service's database instead of in every tenant's schema or database.
 */
export function sharedStatementResolver(dialect: SqlDialect, models: EntityModel[][], snapshots: DrizzleSnapshot[]): (statement: string) => boolean {
  const shared = new Map<string, EntityModel>();
  for (const model of models.flat()) if (model.tenancy === "shared" && !model.link) shared.set(model.key, model);
  if (shared.size === 0) return () => false;
  const schema = buildDrizzleSchema([...shared.values()], dialect, { sqliteDefaultPrefix: SQLITE_DEFAULT_SCHEMA_TOKEN });
  const config = (table: unknown) => (dialect === "sqlite" ? sqliteTableConfig(table as never) : pgTableConfig(table as never)) as { name: string; schema?: string };
  const names = new Set<string>();
  for (const [key, table] of Object.entries(schema.tables)) if (!shared.get(key)?.schema) names.add(config(table).name);
  for (const [key, table] of Object.entries(schema.junctions)) if (!shared.get(key.slice(0, key.lastIndexOf(".")))?.schema) names.add(config(table).name);
  const objects = new Set(names);
  for (const snapshot of snapshots) {
    for (const table of Object.values(snapshot.tables)) {
      if (!names.has(table.name) || (dialect === "postgres" && typeof table.schema === "string" && table.schema !== "" && table.schema !== "public")) continue;
      for (const [key, index] of Object.entries(table.indexes)) objects.add((index as { name?: string }).name ?? key);
    }
  }
  if (dialect === "postgres") {
    return (statement) => {
      const first = /"([^"]+)"(\s*\.\s*")?/.exec(statement);
      return Boolean(first && !first[2] && objects.has(first[1]!));
    };
  }
  return (statement) => {
    const first = /`([^`]+)`/.exec(statement)?.[1];
    if (!first) return false;
    return objects.has(first.startsWith(SQLITE_REBUILD_PREFIX) ? first.slice(SQLITE_REBUILD_PREFIX.length) : first);
  };
}
