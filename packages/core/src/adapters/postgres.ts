import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { assertChannelName, invalidConnection, UniqueViolationError, type DatabaseAdapter, type RelatedScope, type StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import { poolSizePerWorker } from "../workers.ts";
import { buildDrizzleSchema, columnName, lazyDrizzleSchema, schemaIdentifier, type DrizzleSchema } from "../sql/schema.ts";
import { schemaViews } from "./schema-views.ts";
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
  /** A view in which the default-schema entities live in `schema`, sharing this adapter's connection. */
  withSchema(schema: string): PostgresAdapter;
  sharesConnectionWith(other: DatabaseAdapter): boolean;
  /** A new, unconnected adapter of this kind for another database. */
  forConnection(connection: unknown): PostgresAdapter;
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

  const translateErrors = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const field = uniqueViolationField(error, models);
      if (field) throw new UniqueViolationError(field);
      throw error;
    }
  };
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

  /**
   * The statements of every entity over the tables of `schemaOf()`, prepared on first use per entity and kept in
   * `statements`: the connected schema for the adapter itself, a view's schema (whose default-schema tables its
   * statements name) for a view. Views share the pool and the open transaction.
   */
  const operations = (schemaOf: () => DrizzleSchema | undefined, statements: Map<string, EntityStatements>) => {
  const tableFor = (entity: EntityModel): Table => {
    const table = schemaOf()?.tables[entity.key];
    if (!table) throw new Error(`Unknown entity ${entity.entityName}`);
    return table;
  };
  const statementsFor = (entity: EntityModel): EntityStatements => {
    let found = statements.get(entity.key);
    if (!found) {
      tableFor(entity);
      found = new EntityStatements(entity, schemaOf()!);
      statements.set(entity.key, found);
    }
    return found;
  };
  /** Records read with precompiled text, whose JSON columns may come back as text. */
  const read = async (entity: EntityModel, statement: Statement) => statementsFor(entity).records(await run(statement));
  /** The owner's table and the junction storing the reference array of a related query, with the target's statements. */
  const relatedOf = (scope: RelatedScope) => {
    const owner = statementsFor(scope.owner);
    const junction = owner.junction(scope.field);
    if (!junction) throw new Error(`${scope.owner.entityName}.${scope.field} is not a stored reference array`);
    return { owner: owner.table, junction, target: statementsFor(scope.target) };
  };

  const methods: Omit<DatabaseAdapter, "connect" | "disconnect"> = {
    insert(entity, record) {
      return translateErrors(() =>
        atomicallyWithRelations(entity, async () => {
          const { columns, relations } = splitRelations(entity, record);
          const [inserted] = await read(entity, statementsFor(entity).insert(columns));
          await writeRelations(executor(), schemaOf()!, entity, record.id, relations);
          // The arrays just written are the stored ones.
          for (const { field } of statementsFor(entity).junctions) inserted![field] = relations[field] ?? [];
          return inserted!;
        }),
      );
    },
    insertOrSkip(entity, record) {
      return translateErrors(async () => {
        const { columns } = splitRelations(entity, record);
        return (await read(entity, statementsFor(entity).insertOrSkip(columns)))[0] ?? null;
      });
    },
    increment(entity, id, amounts, insert) {
      return translateErrors(async () => {
        const { columns } = splitRelations(entity, { ...insert, ...amounts, id });
        return (await read(entity, statementsFor(entity).increment(columns, amounts)))[0]!;
      });
    },
    async findById(entity, id, options) {
      return (await read(entity, statementsFor(entity).findById(id, options?.omit)))[0] ?? null;
    },
    async findOne(entity, where) {
      return (await read(entity, statementsFor(entity).findOne(where)))[0] ?? null;
    },
    async findMany(entity, { where, sort, limit, offset, withTotal = true, omit }) {
      const entityStatements = statementsFor(entity);
      // The page and the count are independent, so they run at the same time.
      const [data, total] = await Promise.all([
        read(entity, entityStatements.findMany(where, sort, limit, offset, omit)),
        withTotal ? run(entityStatements.count(where)).then(([row]) => Number(row?.total ?? 0)) : undefined,
      ]);
      return { data, total: total ?? data.length };
    },
    async findRelated(scope, { where, sort, limit, offset, withTotal = true }) {
      const { junction, target } = relatedOf(scope);
      const [data, total] = await Promise.all([
        read(scope.target, target.findRelated(junction, scope.id, where, sort, limit, offset)),
        withTotal ? run(target.countRelated(junction, scope.id, where)).then(([row]) => Number(row?.total ?? 0)) : undefined,
      ]);
      return { data, total: total ?? data.length };
    },
    async countRelated(scope, where) {
      const { junction, target } = relatedOf(scope);
      const [row] = await run(target.countRelated(junction, scope.id, where));
      return Number(row?.total ?? 0);
    },
    async aggregateRelated(scope, where, aggregates) {
      const { owner, junction, target } = relatedOf(scope);
      const statement = target.aggregateRelated(owner, junction, scope.id, where, aggregates);
      const [row] = await run(statement);
      return row ? statement.decode(row) : null;
    },
    updateById(entity, id, changes, where = []) {
      return translateErrors(() =>
        atomicallyWithRelations(entity, async () => {
          const { columns, relations } = splitRelations(entity, changes);
          // The row comes back with its arrays as they were; the ones written here replace them.
          const [updated] = await read(entity, statementsFor(entity).updateById(id, columns, where));
          if (!updated) return null;
          await writeRelations(executor(), schemaOf()!, entity, id, relations);
          Object.assign(updated, relations);
          return updated;
        }),
      );
    },
    async ping() {
      await run({ text: "select 1", params: [] });
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
      const [row] = await run(statementsFor(entity).count(where));
      return Number(row?.total ?? 0);
    },
    async aggregate(entity, where, aggregates) {
      const statement = statementsFor(entity).aggregate(where, aggregates);
      const [row] = await run(statement);
      return statement.decode(row ?? {});
    },
    transaction,
  };
  return methods;
  };

  const statements = new Map<string, EntityStatements>();
  let views = schemaViews<PostgresAdapter>(() => adapter, (name) => viewOf(name));
  const viewOf = (name: string): Partial<PostgresAdapter> => {
    let viewSchema: DrizzleSchema | undefined;
    const view = {
      kind: "postgres" as const,
      supportsRollback: true,
      get client() {
        return client;
      },
      ...operations(() => (viewSchema ??= schema ? lazyDrizzleSchema(models, "postgres", { defaultSchema: name }, () => schema!) : undefined), new Map()),
    };
    return view as Partial<PostgresAdapter>;
  };
  const adapter: PostgresAdapter = {
    kind: "postgres",
    supportsRollback: true,
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
      const max = connectOptions.poolSize ?? poolSizePerWorker(options.max ?? DEFAULT_POSTGRES_POOL_SIZE, connectOptions.workers);
      // The search path is a connection parameter, so every pooled connection uses the default schema.
      client = new SQL({ url: options.url, max, ...(defaultSchema ? { connection: { search_path: defaultSchema } } : {}) } as never);
      const { drizzle } = await driver;
      drizzleFor = (sqlClient) => drizzle({ client: sqlClient });
      db = drizzleFor(client);
      schema = buildDrizzleSchema(entityModels, "postgres");
      views = schemaViews<PostgresAdapter>(() => adapter, (name) => viewOf(name));
    },
    async disconnect() {
      await client?.close();
      client = undefined;
      db = undefined;
    },
    ...operations(() => schema, statements),
    withSchema: (name) => views.get(name),
    forConnection(connection) {
      const url = typeof connection === "string" ? connection : (connection as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || url === "") throw invalidConnection("postgres", "expected a URL text or { url }");
      if (!/^postgres(ql)?:\/\//i.test(url)) throw invalidConnection("postgres", "expected a postgres:// URL");
      return postgresAdapter({ ...options, url });
    },
    sharesConnectionWith: (other) => other === adapter || views.owns(other),
    async listen(channel, onPayload, onListen) {
      assertChannelName(channel);
      // A client of its own, so the listening connection never takes one of the pool's.
      const listener = new SQL({ url: options.url, max: 1 });
      try {
        const subscription = await listener.listen(channel, onPayload, onListen);
        return async () => {
          try {
            await subscription.unlisten();
          } finally {
            await listener.close();
          }
        };
      } catch (error) {
        await listener.close().catch(() => {});
        throw error;
      }
    },
    async notify(channel, payload) {
      assertChannelName(channel);
      if (!client) throw new Error("The PostgreSQL adapter is not connected");
      // The pool, never a transaction's connection: a notification is sent at once.
      await client`select pg_notify(${channel}, ${payload})`;
    },
  };
  return adapter;
}
