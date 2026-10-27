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
  vector as pgVector,
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
import type { EntityModel, FieldModel, OnDeleteAction, VectorMetric } from "../model.ts";

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
  /**
   * Where the default-schema tables live: on PostgreSQL their statements name this schema (instead of relying on the
   * search path), on SQLite their names get its prefix unless `sqliteDefaultPrefix` is given.
   */
  defaultSchema?: string;
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

/** pgvector operator classes of HNSW indexes, by metric. */
export const VECTOR_OPERATOR_CLASSES: Record<VectorMetric, string> = { cosine: "vector_cosine_ops", l2: "vector_l2_ops", ip: "vector_ip_ops" };

function postgresColumn(field: FieldModel): ColumnBuilder {
  const name = columnName(field.name);
  if (field.vector) return pgVector(name, { dimensions: field.vector.dimensions });
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

/**
 * The table builders of one schema: `table(model)` and `junction(model, field)` define one Drizzle table each, reading
 * the other tables (for references) from `tables` only when a statement needs them.
 */
function schemaBuilder(models: EntityModel[], dialect: SqlDialect, options: DrizzleSchemaOptions, tables: Record<string, AnyTable>) {
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
  // A default schema given here places the default-schema tables: a PostgreSQL schema, or a SQLite prefix.
  const defaultPrefix = options.sqliteDefaultPrefix ?? (options.defaultSchema ? sqliteDefaultPrefix(options.defaultSchema) : "");
  const factoryFor = (model: EntityModel): TableFactory => {
    const placed = model.schema ?? (isSqlite ? undefined : options.defaultSchema);
    if (isSqlite || !placed) return (isSqlite ? sqliteTable : pgTable) as TableFactory;
    const name = schemaIdentifier(placed);
    if (!pgSchemas.has(name)) pgSchemas.set(name, pgSchema(name) as unknown as { table: TableFactory });
    const schema = pgSchemas.get(name)!;
    return schema.table.bind(schema);
  };
  /** Table name in the database, including the SQLite schema prefix. */
  const physicalName = (model: EntityModel) => {
    if (!isSqlite) return model.tableName;
    return model.schema ? `${schemaIdentifier(model.schema)}__${model.tableName}` : `${defaultPrefix}${model.tableName}`;
  };
  /** Prefix of index and constraint names, so they stay unique across schemas. */
  const namePrefix = (model: EntityModel) => {
    if (model.schema) return `${schemaIdentifier(model.schema)}_${model.tableName}`;
    return isSqlite ? `${defaultPrefix}${model.tableName}` : model.tableName;
  };

  const table = (model: EntityModel): AnyTable => {
    const columns: Record<string, ColumnBuilder> = {
      id: text("id").primaryKey(),
      createdAt: createdColumn("created_at").notNull(),
      updatedAt: createdColumn("updated_at").notNull(),
    };
    for (const field of model.fields) {
      // Reference arrays live in junction tables, not in the entity's own columns.
      if (field.storage === "relation" || field.storage === "derived" || field.storage === "computed") continue;
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
    return factoryFor(model)(physicalName(model), columns, (table) => {
      const extras: unknown[] = [index(`${prefix}_created_at_idx`).on(table.createdAt as never)];
      for (const field of model.fields) {
        const column = columnName(field.name);
        if (field.unique) extras.push(uniqueIndex(`${prefix}_${column}_uq`).on(table[field.name] as never));
        if (field.index) extras.push(index(`${prefix}_${column}_idx`).on(table[field.name] as never));
        if (field.type === "enum") {
          extras.push(check(`${prefix}_${column}_check`, enumCheck(table[field.name], field.values)));
        }
        if (!isSqlite && field.vector?.index === "hnsw") {
          const target = (table[field.name] as { op(name: string): unknown }).op(VECTOR_OPERATOR_CLASSES[field.vector.metric]);
          extras.push(pgIndex(`${prefix}_${column}_hnsw`).using("hnsw", target as never));
        }
      }
      for (const { fields, unique } of model.indexes ?? []) {
        const name = `${prefix}_${fields.map(columnName).join("_")}_${unique ? "uq" : "idx"}`;
        const [first, ...rest] = fields.map((field) => table[field] as never);
        extras.push((unique ? uniqueIndex(name) : index(name)).on(first, ...rest));
      }
      return extras;
    });
  };
  /** The junction table of a stored reference array, or undefined when its target is not a model. */
  const junction = (model: EntityModel, field: Extract<FieldModel, { type: "refArray" }>): AnyTable | undefined => {
      const target = models.find((candidate) => candidate.key === field.target);
      if (!target) return undefined;
      const name = field.joinTable
        ? isSqlite
          ? model.schema
            ? `${schemaIdentifier(model.schema)}__${field.joinTable}`
            : `${defaultPrefix}${field.joinTable}`
          : field.joinTable
        : `${physicalName(model)}__${columnName(field.name)}`;
      const prefix = `${namePrefix(model)}__${columnName(field.name)}`;
      const targetOnDelete = field.onDelete === "pull" ? "cascade" : "restrict";
      const integerColumn = (column: string): ColumnBuilder => (isSqlite ? integer(column) : pgInteger(column));
      return factoryFor(model)(
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
  };
  return { table, junction, schemas: () => Object.fromEntries(pgSchemas) };
}

/** The stored reference arrays of a model, which have junction tables. */
const storedArrays = (model: EntityModel) =>
  model.fields.filter((field): field is Extract<FieldModel, { type: "refArray" }> => field.type === "refArray" && field.storage === "relation");

/** Builds the Drizzle table of one model; the schema builders call it, so tests can count the tables built. */
export const tablePlans = {
  table(builder: ReturnType<typeof schemaBuilder>, model: EntityModel): AnyTable {
    return builder.table(model);
  },
};

/** Builds Drizzle table definitions for every entity, so developers never write Drizzle code. */
export function buildDrizzleSchema(models: EntityModel[], dialect: SqlDialect, options: DrizzleSchemaOptions = {}): DrizzleSchema {
  const tables: Record<string, AnyTable> = {};
  const builder = schemaBuilder(models, dialect, options, tables);
  for (const model of models) tables[model.key] = tablePlans.table(builder, model);
  const junctions: Record<string, AnyTable> = {};
  for (const model of models) {
    for (const field of storedArrays(model)) {
      const built = builder.junction(model, field);
      if (built) junctions[junctionKey(model.key, field.name)] = built;
    }
  }
  return { dialect, tables, schemas: builder.schemas(), junctions };
}

/**
 * Like `buildDrizzleSchema`, but each table is built the first time a statement reads it and then kept, so a schema
 * used by a few entities only pays for those. Adapter views use it for their default schema.
 */
export function lazyDrizzleSchema(models: EntityModel[], dialect: SqlDialect, options: DrizzleSchemaOptions = {}, shared?: () => DrizzleSchema): DrizzleSchema {
  const tables: Record<string, AnyTable> = {};
  const builder = schemaBuilder(models, dialect, options, tables);
  // Shared models (`tenancy: "shared"`) keep the tables of `shared`, the parent's schema, wherever the view puts the others.
  const isShared = (model: EntityModel) => shared !== undefined && model.tenancy === "shared";
  const lazy = (target: Record<string, AnyTable>, key: string, build: () => AnyTable | undefined) =>
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get() {
        const value = build();
        Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
        return value;
      },
    });
  for (const model of models) lazy(tables, model.key, () => (isShared(model) ? shared!().tables[model.key]! : tablePlans.table(builder, model)));
  const junctions: Record<string, AnyTable> = {};
  for (const model of models) {
    for (const field of storedArrays(model)) {
      const key = junctionKey(model.key, field.name);
      lazy(junctions, key, () => (isShared(model) ? shared!().junctions[key] : builder.junction(model, field)));
    }
  }
  return { dialect, tables, get schemas() { return builder.schemas(); }, junctions } as DrizzleSchema;
}
