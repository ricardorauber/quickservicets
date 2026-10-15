import { Database } from "bun:sqlite";
import { count, eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import { toOrderBy, toWhere } from "../sql/conditions.ts";
import { buildDrizzleSchema, columnName, type DrizzleSchema } from "../sql/schema.ts";
import { TransactionScope } from "../sql/transaction-scope.ts";

export interface SqliteAdapterOptions {
  /** File path of the database, or `:memory:`. */
  path: string;
}

export interface SqliteAdapter extends DatabaseAdapter {
  /** The underlying `bun:sqlite` database while connected. */
  readonly client: Database | undefined;
}

// Tables are built at runtime from the models, so Drizzle cannot type their columns statically.
type Table = any;
type RunResult = { changes: number };

/** Maps a SQLite unique constraint error to the entity field it concerns. */
export function uniqueViolationField(error: unknown, models: EntityModel[]): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    const match = /UNIQUE constraint failed: ([\w.]+)/.exec(current.message);
    if (match) {
      const [tableName, column] = match[1]!.split(".");
      const model = models.find((candidate) => candidate.tableName === tableName);
      return model?.fields.find((field) => columnName(field.name) === column)?.name ?? column;
    }
    current = current.cause;
  }
  return undefined;
}

export function sqliteAdapter(options: SqliteAdapterOptions): SqliteAdapter {
  let client: Database | undefined;
  let db: BunSQLiteDatabase | undefined;
  let schema: DrizzleSchema | undefined;
  let models: EntityModel[] = [];
  const scope = new TransactionScope();

  const ready = () => {
    if (!db || !schema) throw new Error("The SQLite adapter is not connected");
    return { db, schema };
  };
  const tableFor = (entity: EntityModel) => {
    const table = ready().schema.tables[entity.key];
    if (!table) throw new Error(`Unknown entity ${entity.entityName}`);
    return table as Table;
  };
  const translateErrors = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const field = uniqueViolationField(error, models);
      if (field) throw new UniqueViolationError(field);
      throw error;
    }
  };
  const findById = (entity: EntityModel, id: string) => {
    const table = tableFor(entity);
    const row = ready().db.select().from(table).where(eq(table.id, id)).get();
    return (row as StoredRecord | undefined) ?? null;
  };

  return {
    kind: "sqlite",
    get client() {
      return client;
    },
    async connect(entityModels) {
      models = entityModels;
      client = new Database(options.path, { create: true });
      client.run("PRAGMA foreign_keys = ON");
      db = drizzle(client);
      schema = buildDrizzleSchema(entityModels, "sqlite");
    },
    async disconnect() {
      client?.close();
      client = undefined;
      db = undefined;
    },
    insert(entity, record) {
      return scope.run(() =>
        translateErrors(() => {
          ready().db.insert(tableFor(entity)).values(record).run();
          return findById(entity, record.id)!;
        }),
      );
    },
    findById(entity, id) {
      return scope.run(() => findById(entity, id));
    },
    findOne(entity, where) {
      return scope.run(() => {
        const table = tableFor(entity);
        const row = ready().db.select().from(table).where(toWhere(table, where, "sqlite")).limit(1).get();
        return (row as StoredRecord | undefined) ?? null;
      });
    },
    findMany(entity, { where, sort, limit, offset }) {
      return scope.run(() => {
        const table = tableFor(entity);
        const condition = toWhere(table, where, "sqlite");
        const data = ready()
          .db.select()
          .from(table)
          .where(condition)
          .orderBy(...toOrderBy(table, sort))
          .limit(limit)
          .offset(offset)
          .all() as StoredRecord[];
        const total = ready().db.select({ total: count() }).from(table).where(condition).get()?.total ?? 0;
        return { data, total };
      });
    },
    updateById(entity, id, changes) {
      return scope.run(() =>
        translateErrors(() => {
          const table = tableFor(entity);
          const result = ready().db.update(table).set(changes).where(eq(table.id, id)).run() as unknown as RunResult;
          return result.changes > 0;
        }),
      );
    },
    deleteById(entity, id) {
      return scope.run(() => {
        const table = tableFor(entity);
        return (ready().db.delete(table).where(eq(table.id, id)).run() as unknown as RunResult).changes > 0;
      });
    },
    count(entity, where) {
      return scope.run(() => {
        const table = tableFor(entity);
        return ready().db.select({ total: count() }).from(table).where(toWhere(table, where, "sqlite")).get()?.total ?? 0;
      });
    },
    transaction(fn) {
      return scope.transaction(fn, {
        begin: () => void ready().db.run(sql`begin`),
        commit: () => void ready().db.run(sql`commit`),
        rollback: () => void ready().db.run(sql`rollback`),
      });
    },
  };
}
