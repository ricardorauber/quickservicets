import type { SqlDialect } from "@quickservice/core";
import { generateMigration, generateSQLiteMigration } from "drizzle-kit/api";
import type { DrizzleSnapshot, TableSnapshot } from "./snapshot.ts";

const columnNamesOf = (entries: unknown[]): string[] =>
  entries.map((entry) => (typeof entry === "string" ? entry : String((entry as { expression?: string }).expression ?? "")));

/** `from` without the tables and columns that `to` no longer has; everything else stays as in `from`. */
function withoutRemovals(from: DrizzleSnapshot, to: DrizzleSnapshot): DrizzleSnapshot {
  const tables: Record<string, TableSnapshot> = {};
  for (const [key, table] of Object.entries(from.tables)) {
    const target = to.tables[key];
    if (!target) continue;
    const kept = Object.fromEntries(Object.entries(table.columns).filter(([name]) => name in target.columns));
    const removed = Object.keys(table.columns).filter((name) => !(name in kept));
    const usesRemoved = (columns: string[]) => columns.some((column) => removed.includes(column));
    tables[key] = {
      ...table,
      columns: kept,
      indexes: Object.fromEntries(Object.entries(table.indexes).filter(([, index]) => !usesRemoved(columnNamesOf(index.columns)))),
      foreignKeys: Object.fromEntries(
        Object.entries(table.foreignKeys).filter(([, key]) => !usesRemoved(key.columnsFrom) && key.tableTo in tablesByName(to)),
      ),
      ...(table.checkConstraints
        ? {
            checkConstraints: Object.fromEntries(
              Object.entries(table.checkConstraints).filter(([, check]) => !removed.some((column) => check.value.includes(`"${column}"`))),
            ),
          }
        : {}),
    };
  }
  const result: DrizzleSnapshot = { ...from, id: crypto.randomUUID(), prevId: from.id, tables };
  if (from.schemas && to.schemas) {
    result.schemas = Object.fromEntries(
      Object.entries(from.schemas as Record<string, string>).filter(([key]) => key in (to.schemas as Record<string, string>)),
    );
  }
  return result;
}

function tablesByName(snapshot: DrizzleSnapshot): Record<string, true> {
  return Object.fromEntries(Object.values(snapshot.tables).map((table) => [table.name, true as const]));
}

/**
 * Default-schema PostgreSQL tables stay unqualified so the search path decides where they live, and explicit
 * schemas are created only when missing.
 */
function adaptPostgres(statement: string): string {
  return statement.replaceAll('"public".', "").replace(/^CREATE SCHEMA "/, 'CREATE SCHEMA IF NOT EXISTS "');
}

async function generate(dialect: SqlDialect, from: DrizzleSnapshot, to: DrizzleSnapshot): Promise<string[]> {
  return dialect === "sqlite"
    ? generateSQLiteMigration(from as never, to as never)
    : (await generateMigration(from as never, to as never)).map(adaptPostgres);
}

/**
 * SQL that turns `from` into `to`. Removals and additions are diffed separately, so drizzle-kit never has to ask
 * whether a change is a rename: renames always become a drop followed by an add.
 */
export async function diffSnapshots(dialect: SqlDialect, from: DrizzleSnapshot, to: DrizzleSnapshot): Promise<string[]> {
  const intermediate = withoutRemovals(from, to);
  const statements = [...(await generate(dialect, from, intermediate)), ...(await generate(dialect, intermediate, to))];
  // pgvector columns need the extension, which the first migration adding one creates.
  if (dialect === "postgres" && !hasVectorColumn(from) && hasVectorColumn(to)) statements.unshift(CREATE_VECTOR_EXTENSION);
  return statements;
}

export const CREATE_VECTOR_EXTENSION = "CREATE EXTENSION IF NOT EXISTS vector;";

function hasVectorColumn(snapshot: DrizzleSnapshot): boolean {
  return Object.values(snapshot.tables).some((table) => Object.values(table.columns).some((column) => /^vector\(/.test(String((column as { type?: unknown }).type))));
}

const DATA_LOSS = /\bDROP TABLE\b|\bDROP COLUMN\b|\bSET DATA TYPE\b/i;

export function losesData(statement: string): boolean {
  return DATA_LOSS.test(statement);
}
