import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, count, eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { UniqueViolationError, type Aggregate, type AggregateValues, type DatabaseAdapter, type ReferencePull, type StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import type { Condition } from "../query.ts";
import { aggregateSelection } from "../sql/aggregates.ts";
import { toOrderBy, toWhere, type RelationContext } from "../sql/conditions.ts";
import { poolSizePerWorker } from "../workers.ts";
import { buildDrizzleSchema, columnName, junctionKey, schemaIdentifier, type DrizzleSchema } from "../sql/schema.ts";
import { loadRelations, relationFields, splitRelations, writeRelations } from "../sql/relations.ts";

export interface PostgresAdapterOptions {
  url: string;
  /** Most connections the pool opens (default 10); with `server.workers` above 1 it is divided across the workers. */
  max?: number;
}

export const DEFAULT_POSTGRES_POOL_SIZE = 10;

export interface PostgresAdapter extends DatabaseAdapter {
  /** The underlying `Bun.SQL` client while connected. */
  readonly client: SQL | undefined;
}

// Tables are built at runtime from the models, so Drizzle cannot type their columns statically.
type Table = any;
type Executor = Pick<BunSQLDatabase, "select" | "insert" | "update" | "delete" | "execute">;

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

/** Computes every aggregate over the matching rows in one `select`. */
async function aggregateRow(
  executor: Executor,
  table: Table,
  where: Condition[],
  aggregates: Record<string, Aggregate>,
  context: RelationContext,
): Promise<AggregateValues> {
  const [row] = await executor.select(aggregateSelection(table, aggregates, "postgres", context)).from(table).where(toWhere(table, where, "postgres", context));
  return row as AggregateValues;
}

export function postgresAdapter(options: PostgresAdapterOptions): PostgresAdapter {
  // The driver loads when an adapter is created, so services on other databases never load it.
  const driver = import("drizzle-orm/bun-sql");
  driver.catch(() => {});
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
  const withRelations = (entity: EntityModel, rows: StoredRecord[]) => loadRelations(executor(), schema!, entity, rows);
  const relationContext = (entity: EntityModel) => ({ entity, schema: schema! });
  const transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (transactions.getStore()) return fn();
    if (!db) throw new Error("The PostgreSQL adapter is not connected");
    return db.transaction((tx) => transactions.run(tx as unknown as Executor, fn));
  };
  /** Writes of an entity with reference arrays also write junction rows, so only they need a transaction. */
  const atomicallyWithRelations = <T>(entity: EntityModel, fn: () => Promise<T>): Promise<T> =>
    relationFields(entity).length > 0 ? transaction(fn) : fn();
  /**
   * Common table expressions that delete the junction rows pointing to `id` and move the `updatedAt` of their owners
   * forward, one update per owner table so no row is changed twice in the statement.
   */
  const pullSteps = (entity: EntityModel, id: string, pulls: ReferencePull[], updatedAt: Date) => {
    const at = sql`${updatedAt.toISOString()}::timestamptz`;
    const byOwner = Map.groupBy(pulls.map((pull, index) => ({ ...pull, name: sql.identifier(`pulled_${index}`) })), (pull) => pull.owner);
    const deletes = [...byOwner.values()].flat().map(({ owner, field, name }) => {
      const junction = schema!.junctions[junctionKey(owner.key, field)];
      return sql`${name} as (delete from ${junction} where "target_id" = ${id} returning "owner_id")`;
    });
    const updates = [...byOwner].map(([owner, ownerPulls], index) => {
      const holders = sql.join(ownerPulls.map(({ name }) => sql`select "owner_id" from ${name}`), sql` union `);
      // A record holding its own id is deleted by this statement, so it is not updated as well.
      const others = owner.key === entity.key ? sql` and "id" <> ${id}` : sql``;
      return sql`${sql.identifier(`touched_${index}`)} as (update ${tableFor(owner)} set "updated_at" = greatest(${at}, "updated_at" + interval '1 millisecond') where "id" in (${holders})${others})`;
    });
    return [...deletes, ...updates];
  };
  const first = async (entity: EntityModel, rows: unknown[]): Promise<StoredRecord | null> =>
    rows[0] ? (await withRelations(entity, [rows[0] as StoredRecord]))[0]! : null;

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
      const max = poolSizePerWorker(options.max ?? DEFAULT_POSTGRES_POOL_SIZE, connectOptions.workers);
      // The search path is a connection parameter, so every pooled connection uses the default schema.
      client = new SQL({ url: options.url, max, ...(defaultSchema ? { connection: { search_path: defaultSchema } } : {}) } as never);
      const { drizzle } = await driver;
      db = drizzle({ client });
      schema = buildDrizzleSchema(entityModels, "postgres");
    },
    async disconnect() {
      await client?.close();
      client = undefined;
      db = undefined;
    },
    insert(entity, record) {
      return translateErrors(() =>
        atomicallyWithRelations(entity, async () => {
          const { columns, relations } = splitRelations(entity, record);
          const rows = await executor().insert(tableFor(entity)).values(columns).returning();
          await writeRelations(executor(), schema!, entity, record.id, relations);
          return (await first(entity, rows))!;
        }),
      );
    },
    async findById(entity, id) {
      const table = tableFor(entity);
      return first(entity, await executor().select().from(table).where(eq(table.id, id)).limit(1));
    },
    async findOne(entity, where) {
      const table = tableFor(entity);
      return first(entity, await executor().select().from(table).where(toWhere(table, where, "postgres", relationContext(entity))).limit(1));
    },
    async findMany(entity, { where, sort, limit, offset, withTotal = true }) {
      const table = tableFor(entity);
      const condition = toWhere(table, where, "postgres", relationContext(entity));
      // The page and the count are independent, so they run at the same time.
      const [data, total] = await Promise.all([
        executor().select().from(table).where(condition).orderBy(...toOrderBy(table, sort)).limit(limit).offset(offset) as unknown as Promise<StoredRecord[]>,
        withTotal ? executor().select({ total: count() }).from(table).where(condition).then(([row]) => Number(row?.total ?? 0)) : undefined,
      ]);
      return { data: await withRelations(entity, data), total: total ?? data.length };
    },
    updateById(entity, id, changes, where = []) {
      return translateErrors(() =>
        atomicallyWithRelations(entity, async () => {
          const table = tableFor(entity);
          const { columns, relations } = splitRelations(entity, changes);
          const target = and(eq(table.id, id), toWhere(table, where, "postgres", relationContext(entity)));
          const rows =
            Object.keys(columns).length > 0
              ? await executor().update(table).set(columns).where(target).returning()
              : await executor().select().from(table).where(target);
          if (rows.length > 0) await writeRelations(executor(), schema!, entity, id, relations);
          return first(entity, rows);
        }),
      );
    },
    async lockForUpdate(entity, id) {
      const table = tableFor(entity);
      await executor().select({ id: table.id }).from(table).where(eq(table.id, id)).for("update");
    },
    async deleteById(entity, id) {
      const table = tableFor(entity);
      const rows = await executor().delete(table).where(eq(table.id, id)).returning({ id: table.id });
      return rows.length > 0;
    },
    async deleteAndPull(entity, id, pulls, updatedAt) {
      const table = tableFor(entity);
      const rows = await executor().execute(sql`with ${sql.join(pullSteps(entity, id, pulls, updatedAt), sql`, `)} delete from ${table} where "id" = ${id} returning "id"`);
      return (rows as unknown[]).length > 0;
    },
    async count(entity, where) {
      const table = tableFor(entity);
      const [row] = await executor().select({ total: count() }).from(table).where(toWhere(table, where, "postgres", relationContext(entity)));
      return Number(row?.total ?? 0);
    },
    aggregate(entity, where, aggregates) {
      return aggregateRow(executor(), tableFor(entity), where, aggregates, relationContext(entity));
    },
    transaction,
  };
}
