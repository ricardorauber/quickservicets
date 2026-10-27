import type { Database } from "bun:sqlite";
import { and, count, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { invalidConnection, UniqueViolationError, type AggregateValues, type DatabaseAdapter, type RelatedScope, type StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import type { Condition } from "../query.ts";
import { aggregateSelection } from "../sql/aggregates.ts";
import { toOrderBy, toWhere } from "../sql/conditions.ts";
import { buildDrizzleSchema, columnName, junctionKey, lazyDrizzleSchema, sqliteDefaultPrefix, type DrizzleSchema } from "../sql/schema.ts";
import { schemaViews } from "./schema-views.ts";
import { TransactionScope } from "../sql/transaction-scope.ts";
import { loadRelations, relationFields, splitRelations, writeRelations } from "../sql/relations.ts";

export interface SqliteAdapterOptions {
  /** File path of the database, or `:memory:`. */
  path: string;
}

export interface SqliteAdapter extends DatabaseAdapter {
  /** The underlying `bun:sqlite` database while connected. */
  readonly client: Database | undefined;
  /** A view in which the default-schema entities live in `schema`, sharing this adapter's connection. */
  withSchema(schema: string): SqliteAdapter;
  sharesConnectionWith(other: DatabaseAdapter): boolean;
  /** A new, unconnected adapter of this kind for another database. */
  forConnection(connection: unknown): SqliteAdapter;
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
      const model = models.find((candidate) => tableName === candidate.tableName || tableName!.endsWith(`__${candidate.tableName}`));
      return model?.fields.find((field) => columnName(field.name) === column)?.name ?? column;
    }
    current = current.cause;
  }
  return undefined;
}

export function sqliteAdapter(options: SqliteAdapterOptions): SqliteAdapter {
  // The driver loads when an adapter is created, so services on other databases never load it.
  const driver = Promise.all([import("bun:sqlite"), import("drizzle-orm/bun-sqlite")]);
  driver.catch(() => {});
  let client: Database | undefined;
  let db: BunSQLiteDatabase | undefined;
  let schema: DrizzleSchema | undefined;
  let models: EntityModel[] = [];
  const scope = new TransactionScope();

  /**
   * The statements of every entity over the tables of `schemaOf()`: the connected schema for the adapter itself, the
   * schema of a view for its default-schema tables. Views share the file handle and the transaction of the adapter.
   */
  const operations = (schemaOf: () => DrizzleSchema | undefined) => {
  const ready = () => {
    const schema = schemaOf();
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
  const withRelations = async (entity: EntityModel, rows: StoredRecord[]) =>
    loadRelations(ready().db, ready().schema, entity, rows);
  /** The columns to select: every column, or all but the omitted fields. */
  const columnsOf = (table: Table, omit: readonly string[] | undefined) => {
    if (!omit || omit.length === 0) return undefined;
    return Object.fromEntries(Object.entries(getTableColumns(table)).filter(([field]) => !omit.includes(field))) as Table;
  };
  const findById = async (entity: EntityModel, id: string, omit?: readonly string[]) => {
    const table = tableFor(entity);
    const columns = columnsOf(table, omit);
    const selection = columns ? ready().db.select(columns) : ready().db.select();
    const row = selection.from(table).where(eq(table.id, id)).get() as StoredRecord | undefined;
    return row ? (await withRelations(entity, [row]))[0]! : null;
  };
  const transactionHooks = {
    begin: () => void ready().db.run(sql`begin`),
    commit: () => void ready().db.run(sql`commit`),
    rollback: () => void ready().db.run(sql`rollback`),
  };
  const relationContext = (entity: EntityModel) => ({ entity, schema: ready().schema });
  /** The junction and target tables of a related query. */
  const relatedOf = (related: RelatedScope) => {
    const junction = ready().schema.junctions[junctionKey(related.owner.key, related.field)] as Table;
    if (!junction) throw new Error(`${related.owner.entityName}.${related.field} is not a stored reference array`);
    return { junction, target: tableFor(related.target) };
  };
  /** The related records of `related` that match `where`, as one condition on the target table. */
  const relatedWhere = (related: RelatedScope, where: Condition[]) => {
    const { junction, target } = relatedOf(related);
    const listed = inArray(target.id, ready().db.select({ id: junction.targetId }).from(junction).where(eq(junction.ownerId, related.id)));
    return and(listed, toWhere(target, where, "sqlite", relationContext(related.target)));
  };
  const atomically = <T>(fn: () => Promise<T>) => scope.transaction(fn, transactionHooks);
  /** Writes of an entity with reference arrays also write junction rows, so only they need a transaction. */
  const atomicallyWithRelations = <T>(entity: EntityModel, fn: () => Promise<T>) =>
    relationFields(entity).length > 0 ? atomically(fn) : scope.run(fn);

  const methods: Omit<DatabaseAdapter, "connect" | "disconnect"> = {
    insert(entity, record) {
      return translateErrors(() =>
        atomicallyWithRelations(entity, async () => {
          const { columns, relations } = splitRelations(entity, record);
          const rows = ready().db.insert(tableFor(entity)).values(columns).returning().all() as StoredRecord[];
          await writeRelations(ready().db, ready().schema, entity, record.id, relations);
          return (await withRelations(entity, rows))[0]!;
        }),
      );
    },
    insertOrSkip(entity, record) {
      return translateErrors(() =>
        scope.run(async () => {
          const { columns } = splitRelations(entity, record);
          // A conflicting row leaves the statement without effect instead of failing it.
          const rows = ready().db.insert(tableFor(entity)).values(columns).onConflictDoNothing().returning().all() as StoredRecord[];
          return rows.length > 0 ? (await withRelations(entity, rows))[0]! : null;
        }),
      );
    },
    increment(entity, id, amounts, insert) {
      return translateErrors(() =>
        scope.run(async () => {
          const table = tableFor(entity);
          const { columns } = splitRelations(entity, { ...insert, ...amounts, id });
          // An upsert adds the amounts in one statement, so concurrent increments never lose a count.
          const set = Object.fromEntries(Object.entries(amounts).map(([field, amount]) => [field, sql`${table[field]} + ${amount}`]));
          const rows = ready().db.insert(table).values(columns).onConflictDoUpdate({ target: table.id, set }).returning().all() as StoredRecord[];
          return (await withRelations(entity, rows))[0]!;
        }),
      );
    },
    findById(entity, id, options) {
      return scope.run(() => findById(entity, id, options?.omit));
    },
    findOne(entity, where) {
      return scope.run(async () => {
        const table = tableFor(entity);
        const row = ready().db.select().from(table).where(toWhere(table, where, "sqlite", relationContext(entity))).limit(1).get() as StoredRecord | undefined;
        return row ? (await withRelations(entity, [row]))[0]! : null;
      });
    },
    findMany(entity, { where, sort, limit, offset, withTotal = true, omit }) {
      return scope.run(async () => {
        const table = tableFor(entity);
        const condition = toWhere(table, where, "sqlite", relationContext(entity));
        const columns = columnsOf(table, omit);
        const data = (columns ? ready().db.select(columns) : ready().db.select())
          .from(table)
          .where(condition)
          .orderBy(...toOrderBy(table, sort))
          .limit(limit)
          .offset(offset)
          .all() as StoredRecord[];
        const total = withTotal ? (ready().db.select({ total: count() }).from(table).where(condition).get()?.total ?? 0) : data.length;
        return { data: await withRelations(entity, data), total };
      });
    },
    findRelated(related, { where, sort, limit, offset, withTotal = true }) {
      return scope.run(async () => {
        const target = tableFor(related.target);
        const condition = relatedWhere(related, where);
        const data = ready()
          .db.select()
          .from(target)
          .where(condition)
          .orderBy(...toOrderBy(target, sort))
          .limit(limit)
          .offset(offset)
          .all() as StoredRecord[];
        const total = withTotal ? (ready().db.select({ total: count() }).from(target).where(condition).get()?.total ?? 0) : data.length;
        return { data: await withRelations(related.target, data), total };
      });
    },
    countRelated(related, where) {
      return scope.run(() => ready().db.select({ total: count() }).from(tableFor(related.target)).where(relatedWhere(related, where)).get()?.total ?? 0);
    },
    aggregateRelated(related, where, aggregates) {
      return scope.run(() => {
        const { junction, target } = relatedOf(related);
        // The owner is aliased, so a reference array to its own entity joins the table twice.
        const owner = alias(tableFor(related.owner), "owner") as Table;
        const context = relationContext(related.target);
        const row = ready()
          .db.select(aggregateSelection(target, aggregates, "sqlite", context, target.id))
          .from(owner)
          .leftJoin(junction, eq(junction.ownerId, owner.id))
          .leftJoin(target, and(eq(target.id, junction.targetId), toWhere(target, where, "sqlite", context)))
          .where(eq(owner.id, related.id))
          .groupBy(owner.id)
          .get();
        return (row as AggregateValues | undefined) ?? null;
      });
    },
    updateById(entity, id, changes, where = []) {
      return translateErrors(() =>
        atomicallyWithRelations(entity, async () => {
          const table = tableFor(entity);
          const { columns, relations } = splitRelations(entity, changes);
          const target = and(eq(table.id, id), toWhere(table, where, "sqlite", relationContext(entity)));
          const rows = (
            Object.keys(columns).length > 0
              ? ready().db.update(table).set(columns).where(target).returning().all()
              : ready().db.select().from(table).where(target).all()
          ) as StoredRecord[];
          if (rows.length === 0) return null;
          await writeRelations(ready().db, ready().schema, entity, id, relations);
          return (await withRelations(entity, rows))[0]!;
        }),
      );
    },
    deleteAndPull(entity, id, pulls, updatedAt) {
      return atomically(async () => {
        const { db, schema } = ready();
        const junctions = pulls.map((pull) => ({ owner: pull.owner, junction: schema.junctions[junctionKey(pull.owner.key, pull.field)] }));
        for (const [owner, ownerJunctions] of Map.groupBy(junctions, (item) => item.owner)) {
          const holders = sql.join(ownerJunctions.map(({ junction }) => sql`select "owner_id" from ${junction} where "target_id" = ${id}`), sql` union `);
          // A record holding its own id is deleted below, so it is not updated as well.
          const others = owner.key === entity.key ? sql` and "id" <> ${id}` : sql``;
          db.run(sql`update ${tableFor(owner)} set "updated_at" = max(${updatedAt.getTime()}, "updated_at" + 1) where "id" in (${holders})${others}`);
        }
        for (const { junction } of junctions) db.run(sql`delete from ${junction} where "target_id" = ${id}`);
        const table = tableFor(entity);
        return (db.delete(table).where(eq(table.id, id)).run() as unknown as RunResult).changes > 0;
      });
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
        return ready().db.select({ total: count() }).from(table).where(toWhere(table, where, "sqlite", relationContext(entity))).get()?.total ?? 0;
      });
    },
    aggregate(entity, where, aggregates) {
      return scope.run(() => {
        const table = tableFor(entity);
        const context = relationContext(entity);
        return ready()
          .db.select(aggregateSelection(table, aggregates, "sqlite", context))
          .from(table)
          .where(toWhere(table, where, "sqlite", context))
          .get() as AggregateValues;
      });
    },
    async ping() {
      ready().db.run(sql`select 1`);
    },
    transaction(fn) {
      return atomically(fn);
    },
  };
  return methods;
  };

  // Each view's tables are built on first use per entity and kept; the views are dropped when the adapter reconnects.
  let views = schemaViews<SqliteAdapter>(() => adapter, (name) => viewOf(name));
  const viewOf = (name: string): Partial<SqliteAdapter> => {
    let viewSchema: DrizzleSchema | undefined;
    const view = {
      kind: "sqlite" as const,
      supportsRollback: true,
      get client() {
        return client;
      },
      ...operations(() => (viewSchema ??= schema ? lazyDrizzleSchema(models, "sqlite", { sqliteDefaultPrefix: sqliteDefaultPrefix(name) }, () => schema!) : undefined)),
    };
    return view as Partial<SqliteAdapter>;
  };
  const adapter: SqliteAdapter = {
    kind: "sqlite",
    supportsRollback: true,
    get client() {
      return client;
    },
    async connect(entityModels, connectOptions = {}) {
      models = entityModels;
      const [{ Database }, { drizzle }] = await driver;
      client = new Database(options.path, { create: true });
      client.run("PRAGMA foreign_keys = ON");
      db = drizzle(client);
      schema = buildDrizzleSchema(entityModels, "sqlite", { sqliteDefaultPrefix: sqliteDefaultPrefix(connectOptions.defaultSchema) });
      views = schemaViews<SqliteAdapter>(() => adapter, (name) => viewOf(name));
    },
    async disconnect() {
      client?.close();
      client = undefined;
      db = undefined;
    },
    ...operations(() => schema),
    withSchema: (name) => views.get(name),
    forConnection(connection) {
      const path = typeof connection === "string" ? connection : (connection as { path?: unknown } | null)?.path;
      if (typeof path !== "string" || path === "") throw invalidConnection("sqlite", "expected a path text or { path }");
      return sqliteAdapter({ ...options, path });
    },
    sharesConnectionWith: (other) => other === adapter || views.owns(other),
  };
  return adapter;
}
