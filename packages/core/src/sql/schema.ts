import { sql, type SQL } from "drizzle-orm";
import {
  boolean as pgBoolean,
  check as pgCheck,
  doublePrecision,
  index as pgIndex,
  jsonb,
  pgTable,
  text as pgText,
  timestamp,
  uniqueIndex as pgUniqueIndex,
  type PgTableWithColumns,
} from "drizzle-orm/pg-core";
import {
  check as sqliteCheck,
  index as sqliteIndex,
  integer,
  real,
  sqliteTable,
  text as sqliteText,
  uniqueIndex as sqliteUniqueIndex,
  type SQLiteTableWithColumns,
} from "drizzle-orm/sqlite-core";
import type { EntityModel, FieldModel, OnDeleteAction } from "../model.ts";

export type SqlDialect = "sqlite" | "postgres";

type AnyTable = SQLiteTableWithColumns<any> | PgTableWithColumns<any>;

export interface DrizzleSchema {
  dialect: SqlDialect;
  /** Drizzle tables keyed by entity key. Column properties use the field names. */
  tables: Record<string, AnyTable>;
}

export function columnName(fieldName: string): string {
  return fieldName.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

const ON_DELETE: Record<OnDeleteAction, "restrict" | "cascade" | "set null"> = {
  restrict: "restrict",
  cascade: "cascade",
  setNull: "set null",
};

function enumCheck(column: unknown, values: string[]): SQL {
  const list = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return sql`${column} in (${sql.raw(list)})`;
}

type ColumnBuilder = any;

function sqliteColumn(field: FieldModel): ColumnBuilder {
  const name = columnName(field.name);
  if (field.storage === "json") return sqliteText(name, { mode: "json" });
  switch (field.type) {
    case "number":
      return real(name);
    case "boolean":
      return integer(name, { mode: "boolean" });
    case "date":
      return integer(name, { mode: "timestamp_ms" });
    default:
      return sqliteText(name);
  }
}

function postgresColumn(field: FieldModel): ColumnBuilder {
  const name = columnName(field.name);
  if (field.storage === "json") return jsonb(name);
  switch (field.type) {
    case "number":
      return doublePrecision(name);
    case "boolean":
      return pgBoolean(name);
    case "date":
      return timestamp(name, { withTimezone: true, mode: "date" });
    default:
      return pgText(name);
  }
}

/** Builds Drizzle table definitions for every entity, so developers never write Drizzle code. */
export function buildDrizzleSchema(models: EntityModel[], dialect: SqlDialect): DrizzleSchema {
  const tables: Record<string, AnyTable> = {};
  const isSqlite = dialect === "sqlite";
  const text = (name: string): ColumnBuilder => (isSqlite ? sqliteText(name) : pgText(name));
  const createdColumn = (name: string) =>
    isSqlite ? integer(name, { mode: "timestamp_ms" }) : timestamp(name, { withTimezone: true, mode: "date" });
  const index = (name: string): ColumnBuilder => (isSqlite ? sqliteIndex(name) : pgIndex(name));
  const uniqueIndex = (name: string): ColumnBuilder => (isSqlite ? sqliteUniqueIndex(name) : pgUniqueIndex(name));
  const check = (name: string, condition: SQL): unknown => (isSqlite ? sqliteCheck(name, condition) : pgCheck(name, condition));
  const tableFactory = (isSqlite ? sqliteTable : pgTable) as (
    name: string,
    columns: Record<string, ColumnBuilder>,
    extra: (table: Record<string, unknown>) => unknown[],
  ) => AnyTable;

  for (const model of models) {
    const columns: Record<string, ColumnBuilder> = {
      id: text("id").primaryKey(),
      createdAt: createdColumn("created_at").notNull(),
      updatedAt: createdColumn("updated_at").notNull(),
    };
    for (const field of model.fields) {
      let column = isSqlite ? sqliteColumn(field) : postgresColumn(field);
      if (!field.optional) column = column.notNull();
      if (field.type === "ref") {
        const target = field.target;
        column = column.references(() => (tables[target] as Record<string, unknown>).id, {
          onDelete: ON_DELETE[field.onDelete],
        });
      }
      columns[field.name] = column;
    }

    tables[model.key] = tableFactory(model.tableName, columns, (table) => {
      const extras: unknown[] = [index(`${model.tableName}_created_at_idx`).on(table.createdAt as never)];
      for (const field of model.fields) {
        const column = columnName(field.name);
        if (field.unique) extras.push(uniqueIndex(`${model.tableName}_${column}_uq`).on(table[field.name] as never));
        if (field.index) extras.push(index(`${model.tableName}_${column}_idx`).on(table[field.name] as never));
        if (field.type === "enum") {
          extras.push(check(`${model.tableName}_${column}_check`, enumCheck(table[field.name], field.values)));
        }
      }
      return extras;
    });
  }
  return { dialect, tables };
}
