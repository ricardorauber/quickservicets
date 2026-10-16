import { sql, type SQL } from "drizzle-orm";
import {
  integer as pgInteger,
  primaryKey as pgPrimaryKey,
  pgSchema,
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
  primaryKey as sqlitePrimaryKey,
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
  /** PostgreSQL schema objects keyed by schema name, so migrations can create them. */
  schemas: Record<string, unknown>;
  /** Junction tables of reference arrays, keyed by `<entity key>.<field name>`. */
  junctions: Record<string, AnyTable>;
}

export const junctionKey = (entityKey: string, field: string) => `${entityKey}.${field}`;

/**
 * Stands for the default schema prefix of SQLite tables in migrations; `migrate` and the adapter replace it with
 * `<default schema>__`, or remove it when there is no default schema.
 */
export const SQLITE_DEFAULT_SCHEMA_TOKEN = "{{default_schema}}";

export interface DrizzleSchemaOptions {
  /** Prefix of default-schema SQLite tables and their index names: `""`, `"<schema>__"` or the token. */
  sqliteDefaultPrefix?: string;
}

export function schemaIdentifier(schema: string): string {
  return schema.replaceAll("-", "_");
}

/** The SQLite prefix for a resolved default schema. */
export function sqliteDefaultPrefix(defaultSchema: string | null | undefined): string {
  return defaultSchema ? `${schemaIdentifier(defaultSchema)}__` : "";
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
export function buildDrizzleSchema(models: EntityModel[], dialect: SqlDialect, options: DrizzleSchemaOptions = {}): DrizzleSchema {
  const tables: Record<string, AnyTable> = {};
  const isSqlite = dialect === "sqlite";
  const text = (name: string): ColumnBuilder => (isSqlite ? sqliteText(name) : pgText(name));
  const createdColumn = (name: string) =>
    isSqlite ? integer(name, { mode: "timestamp_ms" }) : timestamp(name, { withTimezone: true, mode: "date" });
  const index = (name: string): ColumnBuilder => (isSqlite ? sqliteIndex(name) : pgIndex(name));
  const uniqueIndex = (name: string): ColumnBuilder => (isSqlite ? sqliteUniqueIndex(name) : pgUniqueIndex(name));
  const check = (name: string, condition: SQL): unknown => (isSqlite ? sqliteCheck(name, condition) : pgCheck(name, condition));
  type TableFactory = (
    name: string,
    columns: Record<string, ColumnBuilder>,
    extra: (table: Record<string, unknown>) => unknown[],
  ) => AnyTable;
  const pgSchemas = new Map<string, { table: TableFactory }>();
  const factoryFor = (model: EntityModel): TableFactory => {
    if (isSqlite || !model.schema) return (isSqlite ? sqliteTable : pgTable) as TableFactory;
    const name = schemaIdentifier(model.schema);
    if (!pgSchemas.has(name)) pgSchemas.set(name, pgSchema(name) as unknown as { table: TableFactory });
    const schema = pgSchemas.get(name)!;
    return schema.table.bind(schema);
  };
  /** Table name in the database, including the SQLite schema prefix. */
  const physicalName = (model: EntityModel) => {
    if (!isSqlite) return model.tableName;
    return model.schema ? `${schemaIdentifier(model.schema)}__${model.tableName}` : `${options.sqliteDefaultPrefix ?? ""}${model.tableName}`;
  };
  /** Prefix of index and constraint names, so they stay unique across schemas. */
  const namePrefix = (model: EntityModel) => {
    if (model.schema) return `${schemaIdentifier(model.schema)}_${model.tableName}`;
    return isSqlite ? `${options.sqliteDefaultPrefix ?? ""}${model.tableName}` : model.tableName;
  };

  for (const model of models) {
    const columns: Record<string, ColumnBuilder> = {
      id: text("id").primaryKey(),
      createdAt: createdColumn("created_at").notNull(),
      updatedAt: createdColumn("updated_at").notNull(),
    };
    for (const field of model.fields) {
      // Reference arrays live in junction tables, not in the entity's own columns.
      if (field.storage === "relation" || field.storage === "derived") continue;
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

    const prefix = namePrefix(model);
    tables[model.key] = factoryFor(model)(physicalName(model), columns, (table) => {
      const extras: unknown[] = [index(`${prefix}_created_at_idx`).on(table.createdAt as never)];
      for (const field of model.fields) {
        const column = columnName(field.name);
        if (field.unique) extras.push(uniqueIndex(`${prefix}_${column}_uq`).on(table[field.name] as never));
        if (field.index) extras.push(index(`${prefix}_${column}_idx`).on(table[field.name] as never));
        if (field.type === "enum") {
          extras.push(check(`${prefix}_${column}_check`, enumCheck(table[field.name], field.values)));
        }
      }
      return extras;
    });
  }
  const junctions: Record<string, AnyTable> = {};
  for (const model of models) {
    for (const field of model.fields) {
      if (field.type !== "refArray" || field.storage !== "relation") continue;
      const target = models.find((candidate) => candidate.key === field.target);
      if (!target) continue;
      const name = `${physicalName(model)}__${columnName(field.name)}`;
      const prefix = `${namePrefix(model)}__${columnName(field.name)}`;
      const targetOnDelete = field.onDelete === "pull" ? "cascade" : "restrict";
      const integerColumn = (column: string): ColumnBuilder => (isSqlite ? integer(column) : pgInteger(column));
      junctions[junctionKey(model.key, field.name)] = factoryFor(model)(
        name,
        {
          ownerId: text("owner_id").notNull().references(() => (tables[model.key] as Record<string, unknown>).id, { onDelete: "cascade" }),
          targetId: text("target_id").notNull().references(() => (tables[target.key] as Record<string, unknown>).id, { onDelete: targetOnDelete }),
          position: integerColumn("position").notNull(),
        },
        (table) => [
          (isSqlite ? sqlitePrimaryKey : pgPrimaryKey)({ name: `${prefix}_pk`, columns: [table.ownerId as never, table.targetId as never] }),
          index(`${prefix}_target_idx`).on(table.targetId as never),
        ],
      );
    }
  }
  return { dialect, tables, schemas: Object.fromEntries(pgSchemas), junctions };
}
