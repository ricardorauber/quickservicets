import { AsyncLocalStorage } from "node:async_hooks";
import type { ConnectOptions, DatabaseAdapter, FindManyOptions, FindManyResult, RelatedScope, StoredRecord } from "./adapter.ts";
import { ConfigError } from "./config-error.ts";
import { maskConnections } from "./secrets.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import type { EntityModel } from "./model.ts";

/** The name of the database `database` configures, in models and messages. */
export const DEFAULT_DATABASE = "default";

/** What the name of a named database must look like. */
export const DATABASE_NAME = /^[a-z][a-z0-9-]*$/;

/** Whether a named database is split per tenant or shared by every tenant, while the `tenancy` native is enabled. */
export type DatabaseTenancy = "per-tenant" | "shared";

/** A named database written with its settings. */
export interface NamedDatabaseConfig {
  /** The database adapter, like `postgresAdapter({ url })`. */
  adapter: DatabaseAdapter;
  /** `per-tenant` or `shared` while the `tenancy` native is enabled (default `per-tenant`). */
  tenancy?: DatabaseTenancy;
}

/** One entry of the `databases` config key: an adapter, or an adapter with its settings. */
export type NamedDatabaseEntry = DatabaseAdapter | NamedDatabaseConfig;

/** A named database once the config is resolved: its adapter (after `QS_DATABASES_<NAME>_URL`) and settings. */
export interface ResolvedDatabase {
  name: string;
  adapter: DatabaseAdapter;
  tenancy?: DatabaseTenancy;
}

/** The database an entity lives in: its `database`, or `default`. */
export function databaseOf(model: Pick<EntityModel, "database">): string {
  return model.database ?? DEFAULT_DATABASE;
}

/** The variable that sets a named database's connection: `orders` is `QS_DATABASES_ORDERS_URL`. */
export function databaseUrlVariable(name: string): string {
  return `QS_DATABASES_${name.replaceAll("-", "_").toUpperCase()}_URL`;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isAdapter = (value: unknown): value is DatabaseAdapter =>
  isObject(value) && typeof value.connect === "function" && typeof value.findById === "function" && typeof value.transaction === "function";

/** The connection texts set by `QS_DATABASES_<NAME>_URL`, masked wherever secrets are. */
let connectionSecrets: readonly string[] = [];

/** The connection texts of the named databases resolved last, which logs and reports mask. */
export function databaseConnectionSecrets(): readonly string[] {
  return connectionSecrets;
}

/**
 * Validates the `databases` config key and applies `QS_DATABASES_<NAME>_URL` to each entry through its adapter's
 * `forConnection`. Fails with `Invalid databases.<name>: <reason>` for a bad name or entry.
 */
export function resolveDatabases(input: unknown, env: Record<string, string | undefined>): Record<string, ResolvedDatabase> {
  connectionSecrets = [];
  if (input === undefined || input === null) return {};
  if (!isObject(input)) throw new ConfigError("Invalid databases: expected an object of named database adapters, like { orders: postgresAdapter({ url }) }");
  const resolved: Record<string, ResolvedDatabase> = {};
  const secrets: string[] = [];
  for (const [name, entry] of Object.entries(input)) {
    if (name === DEFAULT_DATABASE) throw new ConfigError(`Invalid databases.${name}: the name default is taken by the database of database`);
    if (!DATABASE_NAME.test(name)) throw new ConfigError(`Invalid databases.${name}: names must match ^[a-z][a-z0-9-]*$`);
    const settings = isAdapter(entry) ? { adapter: entry } : entry;
    if (!isObject(settings) || !isAdapter(settings.adapter)) {
      throw new ConfigError(`Invalid databases.${name}: expected a database adapter or { adapter, tenancy? }`);
    }
    const tenancy = settings.tenancy;
    if (tenancy !== undefined && tenancy !== "per-tenant" && tenancy !== "shared") {
      throw new ConfigError(`Invalid databases.${name}: tenancy must be "per-tenant" or "shared", got ${JSON.stringify(tenancy)}`);
    }
    let adapter = settings.adapter;
    const variable = databaseUrlVariable(name);
    const connection = env[variable];
    if (connection !== undefined && connection !== "") {
      // A memory database has no connection to set, even though its adapter opens copies of itself for tenants.
      if (adapter.kind === "memory" || !adapter.forConnection) throw new ConfigError(`${variable} cannot be used with the ${adapter.kind ?? "configured"} adapter`);
      try {
        adapter = adapter.forConnection(connection);
      } catch (error) {
        throw new ConfigError(`Invalid ${variable} (databases.${name}): ${maskConnections((error as Error)?.message ?? String(error), [connection])}`);
      }
      secrets.push(connection);
    }
    resolved[name] = { name, adapter, ...(tenancy ? { tenancy } : {}) };
  }
  connectionSecrets = secrets;
  return resolved;
}

/** An adapter that routes each entity to the adapter of its database; `config.database` is one when `databases` is set. */
export interface DatabaseRouter extends DatabaseAdapter {
  /** Every database's adapter by name, `default` first, then the named ones by name. */
  readonly databases: Readonly<Record<string, DatabaseAdapter>>;
  /** The adapter of the database an entity lives in. */
  adapterOf(model: Pick<EntityModel, "database">): DatabaseAdapter;
}

const routers = new WeakSet<object>();

/** Whether an adapter routes entities to several databases. */
export function isDatabaseRouter(adapter: unknown): adapter is DatabaseRouter {
  return typeof adapter === "object" && adapter !== null && routers.has(adapter);
}

/** Every database of an adapter by name: the router's, or `default` alone for a single adapter. */
export function databaseAdapters(adapter: DatabaseAdapter): [string, DatabaseAdapter][] {
  return isDatabaseRouter(adapter) ? Object.entries(adapter.databases) : [[DEFAULT_DATABASE, adapter]];
}

/** The database name an error came from, set by the router on errors of its databases. */
export function errorDatabase(error: unknown): string | undefined {
  const name = (error as { database?: unknown } | null | undefined)?.database;
  return typeof name === "string" ? name : undefined;
}

/** Marks an error with the database it came from, so logs and reports name it; errors already marked keep theirs. */
function tagged(error: unknown, name: string): unknown {
  if (typeof error !== "object" || error === null || errorDatabase(error) !== undefined) return error;
  try {
    Object.defineProperty(error, "database", { value: name, enumerable: false, configurable: true, writable: true });
  } catch {
    // A frozen error keeps its shape.
  }
  return error;
}

/** One `transaction` of a router family, bound to the database of the first entity it touches. */
interface RoutedTransaction {
  family: object;
  database?: string;
  /** Set once fn ended: later calls (from work it did not await) run outside the transaction. */
  closed?: boolean;
  /** Runs a call inside the bound database's transaction. */
  run?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Commits (no error) or rolls back (an error) the bound database's transaction. */
  finish?: (error?: unknown) => void;
  /** Settles when the bound database's transaction ended. */
  done?: Promise<unknown>;
}

const transactions = new AsyncLocalStorage<RoutedTransaction>();

/** Starts the transaction of `adapter` for `state`, kept open until `state.finish`; calls run inside it through `state.run`. */
function bind(state: RoutedTransaction, name: string, adapter: DatabaseAdapter): void {
  state.database = name;
  let snapshot: (<T>(fn: () => T) => T) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    state.done = adapter.transaction(
      () =>
        new Promise((commit, rollback) => {
          snapshot = AsyncLocalStorage.snapshot();
          state.finish = (error) => (error === undefined ? commit(undefined) : rollback(error));
          resolve();
        }),
    );
    state.done.catch(reject);
  });
  // A transaction that never started (no connection) fails its first call; nothing is left to settle.
  ready.catch(() => {});
  state.run = async (fn) => {
    await ready;
    return snapshot!(fn);
  };
}

/** The optional record methods a router offers only when every database's adapter has them. */
const OPTIONAL = ["increment", "insertOrSkip", "deleteAndPull", "lockForUpdate", "findRelated", "countRelated", "aggregateRelated"] as const;

export interface DatabaseRouterOptions {
  /** Receives `database <name> holds no entity` (default: JSON lines on stdout). */
  logger?: Logger;
}

/**
 * An adapter over the default database and the named ones: every call on an entity goes to the adapter of its
 * `database`, `connect` and `disconnect` reach every database, and a `transaction` belongs to the database of the
 * first entity it touches. Errors of a database carry its name as `database`.
 */
export function databaseRouter(defaultAdapter: DatabaseAdapter, named: Readonly<Record<string, DatabaseAdapter>>, options: DatabaseRouterOptions = {}): DatabaseRouter {
  return createRouter({ [DEFAULT_DATABASE]: defaultAdapter, ...Object.fromEntries(Object.keys(named).sort().map((name) => [name, named[name]!])) }, {}, options);
}

function createRouter(databases: Record<string, DatabaseAdapter>, family: object, options: DatabaseRouterOptions): DatabaseRouter {
  const logger = options.logger ?? jsonLogger;
  const names = Object.keys(databases);
  const defaultAdapter = databases[DEFAULT_DATABASE]!;
  const adapterOf = (model: Pick<EntityModel, "database">): DatabaseAdapter => {
    const name = databaseOf(model);
    const adapter = databases[name];
    if (!adapter) throw new Error(`Unknown database ${name} (configured: ${names.join(", ")})`);
    return adapter;
  };

  /** Runs a call on an entity's database: inside the open transaction when it belongs to that database. */
  const call = async <T>(model: Pick<EntityModel, "database">, fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> => {
    const name = databaseOf(model);
    const adapter = adapterOf(model);
    try {
      const state = transactions.getStore();
      if (state && state.family === family && !state.closed) {
        if (state.database === undefined) bind(state, name, adapter);
        if (state.database === name) return await state.run!(() => fn(adapter));
      }
      return await fn(adapter);
    } catch (error) {
      throw tagged(error, name);
    }
  };

  /** Related records of an owner in another database: the owner's array is read, then the target filtered by id. */
  const relatedIds = async (scope: RelatedScope): Promise<string[] | null> => {
    const owner = await call(scope.owner, (adapter) => adapter.findById(scope.owner, scope.id));
    return owner ? ((owner[scope.field] as string[] | null) ?? []) : null;
  };
  const sameDatabase = (scope: RelatedScope) => databaseOf(scope.owner) === databaseOf(scope.target);

  let views: Map<string, DatabaseRouter> | undefined;
  const router: DatabaseRouter = {
    kind: defaultAdapter.kind,
    ...(defaultAdapter.namespace !== undefined ? { namespace: defaultAdapter.namespace } : {}),
    databases,
    adapterOf,
    async connect(models: EntityModel[], connectOptions?: ConnectOptions) {
      const connected: DatabaseAdapter[] = [];
      for (const name of names) {
        const adapter = databases[name]!;
        const own = models.filter((model) => databaseOf(model) === name);
        try {
          await adapter.connect(own, connectOptions);
          // Adapters that connect lazily are reached once, so a database that is down fails the start.
          await adapter.ping?.();
        } catch (error) {
          connected.push(adapter);
          await Promise.allSettled(connected.map((opened) => opened.disconnect()));
          const reason = maskConnections((error as Error)?.message ?? String(error), databaseConnectionSecrets());
          throw tagged(new Error(`Cannot connect database ${name} (${adapter.kind ?? "custom"}): ${reason}`, { cause: error }), name);
        }
        connected.push(adapter);
        if (own.length === 0 && name !== DEFAULT_DATABASE && !announced.has(adapter)) {
          announced.add(adapter);
          safeLog(logger, "info", { timestamp: new Date().toISOString(), message: `database ${name} holds no entity`, database: name });
        }
      }
    },
    async disconnect() {
      const results = await Promise.allSettled(names.map((name) => databases[name]!.disconnect()));
      const failed = results.findIndex((result) => result.status === "rejected");
      if (failed >= 0) throw tagged((results[failed] as PromiseRejectedResult).reason, names[failed]!);
    },
    findById: (entity, id, read) => call(entity, (adapter) => adapter.findById(entity, id, read)),
    findOne: (entity, where) => call(entity, (adapter) => adapter.findOne(entity, where)),
    findMany: (entity, query) => call(entity, (adapter) => adapter.findMany(entity, query)),
    insert: (entity, record) => call(entity, (adapter) => adapter.insert(entity, record)),
    updateById: (entity, id, changes, where) => call(entity, (adapter) => adapter.updateById(entity, id, changes, where)),
    deleteById: (entity, id) => call(entity, (adapter) => adapter.deleteById(entity, id)),
    count: (entity, where) => call(entity, (adapter) => adapter.count(entity, where)),
    aggregate: (entity, where, aggregates) => call(entity, (adapter) => adapter.aggregate(entity, where, aggregates)),
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      const current = transactions.getStore();
      if (current && current.family === family && !current.closed) return fn();
      const state: RoutedTransaction = { family };
      let result: T;
      try {
        result = await transactions.run(state, fn);
      } catch (error) {
        state.closed = true;
        if (state.finish) {
          state.finish(error);
          await state.done!.catch(() => {});
        }
        throw error;
      }
      state.closed = true;
      if (state.finish) {
        state.finish();
        try {
          await state.done;
        } catch (error) {
          throw tagged(error, state.database!);
        }
      }
      return result;
    },
    get supportsRollback() {
      return names.every((name) => databases[name]!.supportsRollback === true);
    },
    async ping() {
      for (const name of names) {
        const adapter = databases[name]!;
        try {
          if (adapter.ping) await adapter.ping();
        } catch (error) {
          throw tagged(error, name);
        }
      }
    },
    sharesConnectionWith: (other) => other === router || (isDatabaseRouter(other) && familyOf.get(other) === family),
  };
  const all = names.map((name) => databases[name]!);
  for (const method of OPTIONAL) {
    if (!all.every((adapter) => typeof adapter[method] === "function")) continue;
    switch (method) {
      case "increment":
        router.increment = (entity, id, amounts, insert) => call(entity, (adapter) => adapter.increment!(entity, id, amounts, insert));
        break;
      case "insertOrSkip":
        router.insertOrSkip = (entity, record, unique) => call(entity, (adapter) => adapter.insertOrSkip!(entity, record, unique));
        break;
      case "deleteAndPull":
        router.deleteAndPull = (entity, id, pulls, updatedAt) => call(entity, (adapter) => adapter.deleteAndPull!(entity, id, pulls, updatedAt));
        break;
      case "lockForUpdate":
        router.lockForUpdate = (entity, id) => call(entity, (adapter) => adapter.lockForUpdate!(entity, id));
        break;
      case "findRelated":
        router.findRelated = async (scope: RelatedScope, query: FindManyOptions): Promise<FindManyResult> => {
          if (sameDatabase(scope)) return call(scope.owner, (adapter) => adapter.findRelated!(scope, query));
          const ids = await relatedIds(scope);
          if (!ids || ids.length === 0) return { data: [] as StoredRecord[], total: 0 };
          return router.findMany(scope.target, { ...query, where: [{ field: "id", op: "in", value: ids }, ...query.where] });
        };
        break;
      case "countRelated":
        router.countRelated = async (scope, where) => {
          if (sameDatabase(scope)) return call(scope.owner, (adapter) => adapter.countRelated!(scope, where));
          const ids = await relatedIds(scope);
          return ids && ids.length > 0 ? router.count(scope.target, [{ field: "id", op: "in", value: ids }, ...where]) : 0;
        };
        break;
      case "aggregateRelated":
        router.aggregateRelated = async (scope, where, aggregates) => {
          if (sameDatabase(scope)) return call(scope.owner, (adapter) => adapter.aggregateRelated!(scope, where, aggregates));
          const ids = await relatedIds(scope);
          if (!ids) return null;
          return router.aggregate(scope.target, [{ field: "id", op: "in", value: ids }, ...where], aggregates);
        };
        break;
    }
  }
  if (defaultAdapter.listen) router.listen = defaultAdapter.listen.bind(defaultAdapter);
  if (defaultAdapter.notify) router.notify = defaultAdapter.notify.bind(defaultAdapter);
  if (defaultAdapter.withSchema) {
    // A schema view moves the default database's entities into the schema; it shares the router's transactions.
    router.withSchema = (schema) => {
      views ??= new Map();
      let view = views.get(schema);
      if (!view) {
        view = createRouter({ ...databases, [DEFAULT_DATABASE]: defaultAdapter.withSchema!(schema) }, family, options);
        views.set(schema, view);
      }
      return view;
    };
  }
  if (defaultAdapter.forConnection) {
    router.forConnection = (connection) => createRouter({ ...databases, [DEFAULT_DATABASE]: defaultAdapter.forConnection!(connection) }, {}, options);
  }
  routers.add(router);
  familyOf.set(router, family);
  return router;
}

/** The transaction family of each router: a router and its schema views share one. */
const familyOf = new WeakMap<object, object>();

/** The named databases already logged as holding no entity. */
const announced = new WeakSet<DatabaseAdapter>();
