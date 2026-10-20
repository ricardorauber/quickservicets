import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, count, eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { UniqueViolationError, type Aggregate, type AggregateValues, type DatabaseAdapter, type StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import type { Condition } from "../query.ts";
import { aggregateSelection } from "../sql/aggregates.ts";
import { toOrderBy, toWhere, type RelationContext } from "../sql/conditions.ts";
import { poolSizePerWorker } from "../workers.ts";
import { buildDrizzleSchema, columnName, schemaIdentifier, type DrizzleSchema } from "../sql/schema.ts";
import { relationFields, splitRelations, writeRelations } from "../sql/relations.ts";
import { EntityStatements, type Statement } from "./postgres-statements.ts";

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

/** What statements run on: a transaction's connection while one is open, the pool otherwise. */
interface Session {
  sql: SQL;
  db: Executor;
}

type Row = Record<string, unknown>;

export function postgresAdapter(options: PostgresAdapterOptions): PostgresAdapter {
  // The driver loads when an adapter is created, so services on other databases never load it.
  const driver = import("drizzle-orm/bun-sql");
  driver.catch(() => {});
  let client: SQL | undefined;
  let db: BunSQLDatabase | undefined;
  let drizzleFor: ((client: SQL) => BunSQLDatabase) | undefined;
  let schema: DrizzleSchema | undefined;
  let models: EntityModel[] = [];
  const transactions = new AsyncLocalStorage<Session>();
  const statements = new Map<string, EntityStatements>();

  const executor = (): Executor => {
    const current = transactions.getStore()?.db ?? db;
    if (!current) throw new Error("The PostgreSQL adapter is not connected");
    return current;
  };
  /** Runs SQL text with its parameters on the current transaction, or on the pool. */
  const run = async (statement: Statement): Promise<Row[]> => {
    const target = transactions.getStore()?.sql ?? client;
    if (!target) throw new Error("The PostgreSQL adapter is not connected");
    return (await target.unsafe(statement.text, statement.params)) as Row[];
  };
  const tableFor = (entity: EntityModel): Table => {
    const table = schema?.tables[entity.key];
    if (!table) throw new Error(`Unknown entity ${entity.entityName}`);
    return table;
  };
  const statementsFor = (entity: EntityModel): EntityStatements => {
    let found = statements.get(entity.key);
    if (!found) {
      tableFor(entity);
      found = new EntityStatements(entity, schema!);
      statements.set(entity.key, found);
    }
    return found;
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
  /** Adds every reference array to `records`, one query per junction table, in position order. */
  const withRelations = async (entity: EntityModel, records: StoredRecord[]): Promise<StoredRecord[]> => {
    const entityStatements = statementsFor(entity);
    if (entityStatements.junctions.length === 0 || records.length === 0) return records;
    const ids = records.map((record) => record.id);
    for (const junction of entityStatements.junctions) {
      const byOwner = new Map<string, string[]>();
      for (const row of await run(entityStatements.junctionLoad(junction, ids))) {
        const owner = row.ownerId as string;
        let list = byOwner.get(owner);
        if (!list) byOwner.set(owner, (list = []));
        list.push(row.targetId as string);
      }
      for (const record of records) record[junction.field] = byOwner.get(record.id) ?? [];
    }
    return records;
  };
  const relationContext = (entity: EntityModel) => ({ entity, schema: schema! });
  const transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (transactions.getStore()) return fn();
    if (!client || !drizzleFor) throw new Error("The PostgreSQL adapter is not connected");
    const makeDrizzle = drizzleFor;
    return client.begin((tx) => {
      let txDb: BunSQLDatabase | undefined;
      // Drizzle is only set up on the transaction's connection when a statement needs it.
      const session: Session = {
        sql: tx as unknown as SQL,
        get db() {
          return (txDb ??= makeDrizzle(tx as unknown as SQL));
        },
      };
      return transactions.run(session, fn);
    }) as Promise<T>;
  };
  /** Writes of an entity with reference arrays also write junction rows, so only they need a transaction. */
  const atomicallyWithRelations = <T>(entity: EntityModel, fn: () => Promise<T>): Promise<T> =>
    relationFields(entity).length > 0 ? transaction(fn) : fn();
  /** Records read with precompiled text, whose JSON columns may come back as text. */
  const read = async (entity: EntityModel, statement: Statement) => statementsFor(entity).records(await run(statement));
  const first = async (entity: EntityModel, rows: StoredRecord[]): Promise<StoredRecord | null> =>
    rows[0] ? (await withRelations(entity, [rows[0]]))[0]! : null;

  return {
    kind: "postgres",
    get client() {
      return client;
    },
    async connect(entityModels, connectOptions = {}) {
      models = entityModels;
      statements.clear();
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
      drizzleFor = (sqlClient) => drizzle({ client: sqlClient });
      db = drizzleFor(client);
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
          const rows = await read(entity, statementsFor(entity).insert(columns));
          await writeRelations(executor(), schema!, entity, record.id, relations);
          return (await first(entity, rows))!;
        }),
      );
    },
    async findById(entity, id) {
      return first(entity, await read(entity, statementsFor(entity).findById(id)));
    },
    async findOne(entity, where) {
      const table = tableFor(entity);
      const rows = await executor().select().from(table).where(toWhere(table, where, "postgres", relationContext(entity))).limit(1);
      return first(entity, rows as StoredRecord[]);
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
          const { columns, relations } = splitRelations(entity, changes);
          const precompiled = statementsFor(entity).updateById(id, columns, where);
          let rows: StoredRecord[];
          if (precompiled) {
            rows = await read(entity, precompiled);
          } else {
            const table = tableFor(entity);
            const target = and(eq(table.id, id), toWhere(table, where, "postgres", relationContext(entity)));
            rows = (
              Object.keys(columns).length > 0
                ? await executor().update(table).set(columns).where(target).returning()
                : await executor().select().from(table).where(target)
            ) as StoredRecord[];
          }
          if (rows.length > 0) await writeRelations(executor(), schema!, entity, id, relations);
          return first(entity, rows);
        }),
      );
    },
    async lockForUpdate(entity, id) {
      await run(statementsFor(entity).lockForUpdate(id));
    },
    async deleteById(entity, id) {
      return (await run(statementsFor(entity).deleteById(id))).length > 0;
    },
    async deleteAndPull(entity, id, pulls, updatedAt) {
      const targets = pulls.map(({ owner, field }) => {
        const ownerStatements = statementsFor(owner);
        return { owner: ownerStatements, junction: ownerStatements.junctions.find((junction) => junction.field === field)! };
      });
      return (await run(statementsFor(entity).deleteAndPull(id, targets, updatedAt))).length > 0;
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
