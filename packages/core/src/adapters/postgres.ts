import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { count, eq } from "drizzle-orm";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import { toOrderBy, toWhere } from "../sql/conditions.ts";
import { buildDrizzleSchema, columnName, schemaIdentifier, type DrizzleSchema } from "../sql/schema.ts";

export interface PostgresAdapterOptions {
  url: string;
}

export interface PostgresAdapter extends DatabaseAdapter {
  /** The underlying `Bun.SQL` client while connected. */
  readonly client: SQL | undefined;
}

// Tables are built at runtime from the models, so Drizzle cannot type their columns statically.
type Table = any;
type Executor = Pick<BunSQLDatabase, "select" | "insert" | "update" | "delete">;

interface PostgresErrorLike {
  errno?: string;
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
}

/** Maps a PostgreSQL unique violation (SQLSTATE 23505) to the entity field, using the index name. */
export function uniqueViolationField(error: unknown, models: EntityModel[]): string | undefined {
  let current = error as PostgresErrorLike | undefined;
  while (current && typeof current === "object") {
    if (current.errno === "23505" || current.code === "23505") {
      const constraint = current.constraint ?? /unique constraint "([^"]+)"/.exec(current.message ?? "")?.[1];
      for (const model of models) {
        for (const field of model.fields) {
          const prefix = model.schema ? `${schemaIdentifier(model.schema)}_${model.tableName}` : model.tableName;
          if (constraint === `${prefix}_${columnName(field.name)}_uq`) return field.name;
        }
      }
      return constraint ?? "unknown";
    }
    current = current.cause as PostgresErrorLike | undefined;
  }
  return undefined;
}

export function postgresAdapter(options: PostgresAdapterOptions): PostgresAdapter {
  let client: SQL | undefined;
  let db: BunSQLDatabase | undefined;
  let schema: DrizzleSchema | undefined;
  let models: EntityModel[] = [];
  const transactions = new AsyncLocalStorage<Executor>();

  const executor = (): Executor => {
    const current = transactions.getStore() ?? db;
    if (!current) throw new Error("The PostgreSQL adapter is not connected");
    return current;
  };
  const tableFor = (entity: EntityModel): Table => {
    const table = schema?.tables[entity.key];
    if (!table) throw new Error(`Unknown entity ${entity.entityName}`);
    return table;
  };
  const translateErrors = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const field = uniqueViolationField(error, models);
      if (field) throw new UniqueViolationError(field);
      throw error;
    }
  };
  const first = <T>(rows: T[]): T | null => rows[0] ?? null;

  return {
    kind: "postgres",
    get client() {
      return client;
    },
    async connect(entityModels, connectOptions = {}) {
      models = entityModels;
      const defaultSchema = connectOptions.defaultSchema ? schemaIdentifier(connectOptions.defaultSchema) : undefined;
      if (defaultSchema) {
        const admin = new SQL(options.url);
        await admin.unsafe(`create schema if not exists "${defaultSchema}"`);
        await admin.close();
      }
      // The search path is a connection parameter, so every pooled connection uses the default schema.
      client = defaultSchema ? new SQL({ url: options.url, connection: { search_path: defaultSchema } } as never) : new SQL(options.url);
      db = drizzle({ client });
      schema = buildDrizzleSchema(entityModels, "postgres");
    },
    async disconnect() {
      await client?.close();
      client = undefined;
      db = undefined;
    },
    insert(entity, record) {
      return translateErrors(async () => {
        const rows = await executor().insert(tableFor(entity)).values(record).returning();
        return rows[0] as StoredRecord;
      });
    },
    async findById(entity, id) {
      const table = tableFor(entity);
      return first(await executor().select().from(table).where(eq(table.id, id)).limit(1)) as StoredRecord | null;
    },
    async findOne(entity, where) {
      const table = tableFor(entity);
      return first(await executor().select().from(table).where(toWhere(table, where, "postgres")).limit(1)) as StoredRecord | null;
    },
    async findMany(entity, { where, sort, limit, offset }) {
      const table = tableFor(entity);
      const condition = toWhere(table, where, "postgres");
      const data = (await executor()
        .select()
        .from(table)
        .where(condition)
        .orderBy(...toOrderBy(table, sort))
        .limit(limit)
        .offset(offset)) as StoredRecord[];
      const [row] = await executor().select({ total: count() }).from(table).where(condition);
      return { data, total: Number(row?.total ?? 0) };
    },
    updateById(entity, id, changes) {
      return translateErrors(async () => {
        const table = tableFor(entity);
        const rows = await executor().update(table).set(changes).where(eq(table.id, id)).returning({ id: table.id });
        return rows.length > 0;
      });
    },
    async deleteById(entity, id) {
      const table = tableFor(entity);
      const rows = await executor().delete(table).where(eq(table.id, id)).returning({ id: table.id });
      return rows.length > 0;
    },
    async count(entity, where) {
      const table = tableFor(entity);
      const [row] = await executor().select({ total: count() }).from(table).where(toWhere(table, where, "postgres"));
      return Number(row?.total ?? 0);
    },
    async transaction(fn) {
      if (transactions.getStore()) return fn();
      if (!db) throw new Error("The PostgreSQL adapter is not connected");
      return db.transaction((tx) => transactions.run(tx as unknown as Executor, fn));
    },
  };
}
