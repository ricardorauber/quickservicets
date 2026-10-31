import { AsyncLocalStorage } from "node:async_hooks";
import type { ConnectOptions, DatabaseAdapter, FindManyOptions, FindManyResult, RelatedScope, StoredRecord } from "./adapter.ts";
import { ConfigError } from "./config-error.ts";
import { HttpError } from "./errors.ts";
import { secret, type AnyOptionSchema } from "./options.ts";
import { databaseModels } from "./database-staging.ts";
import { maskConnections } from "./secrets.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import type { EntityModel, FieldModel } from "./model.ts";

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
  /**
   * The connection of each database-strategy tenant's copy of this database: a text with `{tenant}`, like
   * `orders_{tenant}.db`, or a function `({ tenant }) => connection`.
   */
  tenantConnection?: TenantConnection;
}

/** The connection of a tenant's copy of a named database: a template with `{tenant}`, or a function of the tenant. */
export type TenantConnection = string | ((context: { tenant: { id: string } }) => unknown);

/** One entry of the `databases` config key: an adapter, or an adapter with its settings. */
export type NamedDatabaseEntry = DatabaseAdapter | NamedDatabaseConfig;

/** A named database once the config is resolved: its adapter (after `QS_DATABASES_<NAME>_URL`) and settings. */
export interface ResolvedDatabase {
  name: string;
  adapter: DatabaseAdapter;
  /** Set while the `tenancy` native is enabled: `per-tenant` (the default) or `shared`. */
  tenancy?: DatabaseTenancy;
  tenantConnection?: TenantConnection;
}

/** The database an entity lives in: its `database`, or `default`. */
export function databaseOf(model: Pick<EntityModel, "database">): string {
  return model.database ?? DEFAULT_DATABASE;
}

/** The problem of a feature whose `database` option names no configured database, or undefined. */
export function featureDatabaseProblem(key: string, database: unknown, names: readonly string[]): string | undefined {
  if (database === undefined || database === DEFAULT_DATABASE || names.includes(database as string)) return undefined;
  return `Invalid ${key}.database: unknown database ${String(database)} (configured: ${[DEFAULT_DATABASE, ...names].join(", ")})`;
}

/**
 * Places the entities features contribute, while the service has named databases (its models record databases): an
 * entity derived from another (`derivedFrom`) lives in that entity's database, a per-database one has the default
 * database as home, and every other one lives in its feature's `database` option (default: the default database).
 */
export function placeFeatureEntities(models: readonly EntityModel[], features: readonly { key: string; options: Record<string, unknown> }[]): EntityModel[] {
  if (!models.some((model) => model.database !== undefined)) return [...models];
  const byKey = new Map(models.map((model) => [model.key, model]));
  const optionOf = new Map(features.map((feature) => [feature.key, feature.options.database as string | undefined]));
  return models.map((model) => {
    if (!model.feature) return model;
    const source = model.derivedFrom ? byKey.get(model.derivedFrom) : undefined;
    const database = source ? databaseOf(source) : model.perDatabase ? DEFAULT_DATABASE : (optionOf.get(model.feature) ?? DEFAULT_DATABASE);
    return model.database === database ? model : { ...model, database };
  });
}

/** A reference or reference array whose target lives in another database than its entity. */
export interface CrossDatabaseReference {
  model: EntityModel;
  field: Extract<FieldModel, { type: "ref" | "refArray" }>;
  target: EntityModel;
}

/**
 * Every stored reference and reference array (and every side of a bidirectional relation) whose target lives in
 * another database: no database enforces them, so the application checks them.
 */
export function crossDatabaseReferences(models: readonly EntityModel[]): CrossDatabaseReference[] {
  const byKey = new Map(models.map((model) => [model.key, model]));
  return models.flatMap((model) =>
    model.link
      ? []
      : model.fields.flatMap((field) => {
          if (field.type !== "ref" && field.type !== "refArray") return [];
          const target = byKey.get(field.target);
          return target && databaseOf(target) !== databaseOf(model) ? [{ model, field, target }] : [];
        }),
  );
}

/** The build line of a reference across databases. */
export const crossDatabaseWarning = ({ model, field, target }: CrossDatabaseReference): string =>
  `${model.entityName}.${field.name} references ${target.entityName} in database ${databaseOf(target)}; there is no database-level integrity or cascade for it`;

/** The variable that sets a named database's connection: `orders` is `QS_DATABASES_ORDERS_URL`. */
export function databaseUrlVariable(name: string): string {
  return `QS_DATABASES_${name.replaceAll("-", "_").toUpperCase()}_URL`;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isAdapter = (value: unknown): value is DatabaseAdapter =>
  isObject(value) && typeof value.connect === "function" && typeof value.findById === "function" && typeof value.transaction === "function";

/**
 * The `QS_DATABASES_<NAME>_URL` variable of each named database, as an optional secret naming the database it
 * overrides, for `.env.example` and `env check`.
 */
export function databaseVariables(names: readonly string[]): { name: string; schema: AnyOptionSchema; owner: string }[] {
  return names.map((name) => ({
    name: databaseUrlVariable(name),
    schema: secret().optional().describe(`The connection of the named database ${name}, over the adapter of databases.${name}`),
    owner: "the project",
  }));
}

/**
 * The startup line of a service with named databases, like `databases: default sqlite (3 entities), orders postgres
 * (5 entities)`: each database's kind and the entities living in it; undefined without named databases.
 */
export function databasesReport(adapter: DatabaseAdapter, models: readonly EntityModel[]): string | undefined {
  if (!isDatabaseRouter(adapter)) return undefined;
  const parts = Object.entries(adapter.databases).map(([name, database]) => {
    const count = models.filter((model) => !model.link && databaseOf(model) === name).length;
    return `${name} ${database.kind ?? "custom"} (${count} ${count === 1 ? "entity" : "entities"})`;
  });
  return `databases: ${parts.join(", ")}`;
}

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
export function resolveDatabases(
  input: unknown,
  env: Record<string, string | undefined>,
  options: { tenancy?: boolean; warnings?: string[] } = {},
): Record<string, ResolvedDatabase> {
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
      throw new ConfigError(`Invalid databases.${name}: expected a database adapter or { adapter, tenancy?, tenantConnection? }`);
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
    const tenantConnection = settings.tenantConnection;
    if (tenantConnection !== undefined && typeof tenantConnection !== "string" && typeof tenantConnection !== "function") {
      throw new ConfigError(`Invalid databases.${name}: tenantConnection must be a text with {tenant} or a function of the tenant`);
    }
    // Without the tenancy native every database is global, and a tenancy setting is ignored with a warning.
    if (!options.tenancy && (tenancy !== undefined || tenantConnection !== undefined)) {
      options.warnings?.push(`databases.${name}.${tenancy !== undefined ? "tenancy" : "tenantConnection"} has no effect without the tenancy native`);
    }
    const effective = options.tenancy ? (tenancy ?? "per-tenant") : undefined;
    resolved[name] = { name, adapter, ...(effective ? { tenancy: effective } : {}), ...(options.tenancy && tenantConnection !== undefined ? { tenantConnection: tenantConnection as TenantConnection } : {}) };
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
  /** A view of the router whose transactions belong to the database `name` from their start. */
  on(name: string, subject?: string): DatabaseRouter;
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

/** A call on an entity of another database inside a transaction; a transaction covers one database. */
export class CrossDatabaseTransactionError extends HttpError {
  /** The database of the open transaction. */
  readonly transactionDatabase: string;
  /** The database the refused call or transaction belongs to. */
  readonly database: string;

  constructor(subject: string, database: string, transactionDatabase: string) {
    super(500, `Cannot use ${subject} (database ${database}) inside a transaction of database ${transactionDatabase}; a transaction covers one database. Use a saga or the outbox for changes across databases`, {
      code: "CROSS_DATABASE_TRANSACTION",
    });
    this.name = "CrossDatabaseTransactionError";
    this.database = database;
    this.transactionDatabase = transactionDatabase;
  }
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

/** The open transaction of a router family, when the caller runs inside one. */
function openTransaction(family: object | undefined): RoutedTransaction | undefined {
  const state = transactions.getStore();
  return state && family !== undefined && state.family === family && !state.closed ? state : undefined;
}

/**
 * Runs `fn` outside the open transaction of named databases: its calls on any database run on their own, never
 * joining or being refused by it. The framework's checks across databases (references, `restrict`) run this way.
 */
export function outsideTransaction<T>(fn: () => T): T {
  return transactions.getStore() ? transactions.run(undefined as never, fn) : fn();
}

/**
 * Runs `fn`, a read or write of `other` that `model`'s code needs, outside the open transaction when the two entities
 * live in different databases (the application's checks across databases), and as it is otherwise.
 */
export function acrossDatabases<T>(model: Pick<EntityModel, "database">, other: Pick<EntityModel, "database">, fn: () => T): T {
  // Inside a transaction of `other`'s own database the work joins it: outside, a single-connection database (SQLite,
  // memory) would wait for that very transaction to end.
  return databaseOf(model) === databaseOf(other) || currentTransactionDatabase() === databaseOf(other) ? fn() : outsideTransaction(fn);
}

/** The database the open transaction of `adapter` (a router or one of its views) belongs to, once it touched one. */
export function transactionDatabase(adapter: DatabaseAdapter): string | undefined {
  return openTransaction(familyOf.get(adapter))?.database;
}

/** The database the caller's open transaction belongs to, of any router, once it touched one. */
export function currentTransactionDatabase(): string | undefined {
  const state = transactions.getStore();
  return state && !state.closed ? state.database : undefined;
}

/**
 * Called when a transaction asked for `adapter` joins one already open: a view bound to a database binds the open
 * transaction to it, or throws `CrossDatabaseTransactionError` when it belongs to another database.
 */
export function joinTransactionDatabase(adapter: DatabaseAdapter): void {
  const bound = boundDatabases.get(adapter);
  if (bound === undefined) return;
  const state = openTransaction(familyOf.get(adapter));
  if (!state) return;
  if (state.database === undefined) bind(state, bound.name, (adapter as DatabaseRouter).databases[bound.name]!);
  else if (state.database !== bound.name) throw new CrossDatabaseTransactionError(bound.subject, bound.name, state.database);
}

/** The database each bound view of a router names, and what its transactions are for (an entity, or `a transaction`). */
const boundDatabases = new WeakMap<object, { name: string; subject: string }>();

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
  /** With the tenancy native, whether each named database is split per tenant or shared. */
  tenancy?: Readonly<Record<string, DatabaseTenancy>>;
  /** The `tenantConnection` of each per-tenant named database, for database-strategy tenants. */
  tenantConnections?: Readonly<Record<string, TenantConnection>>;
}

/** The copy of each model without its explicit schema, which a per-tenant database places in the tenant's schema. */
const withoutSchemas = new WeakMap<EntityModel, EntityModel>();
const schemaless = (model: EntityModel): EntityModel => {
  if (model.schema === null) return model;
  let found = withoutSchemas.get(model);
  if (!found) {
    const { schemaKey: _key, ...rest } = model;
    found = { ...rest, schema: null };
    withoutSchemas.set(model, found);
  }
  return found;
};

/** The models of a per-tenant database: their explicit schemas (chosen by the folder) do not place their tables. */
export function tenantDatabaseModels(models: readonly EntityModel[]): EntityModel[] {
  return models.map(schemaless);
}

const tenantViews = new WeakMap<DatabaseAdapter, DatabaseAdapter>();

/**
 * A view of the adapter of a per-tenant named database in which every entity lives in the database's default place
 * (a tenant's schema in its schema views): the module folder chose the database, not a schema of it.
 */
function tenantDatabaseView(adapter: DatabaseAdapter): DatabaseAdapter {
  const known = tenantViews.get(adapter);
  if (known) return known;
  const strip = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map(strip);
    const candidate = value as Partial<EntityModel> & { owner?: unknown; target?: unknown };
    if (typeof candidate.tableName === "string" && Array.isArray(candidate.fields)) return schemaless(candidate as EntityModel);
    if ("owner" in candidate && "target" in candidate) return { ...candidate, owner: strip(candidate.owner), target: strip(candidate.target) };
    if ("owner" in candidate && "field" in candidate) return { ...candidate, owner: strip(candidate.owner) };
    return value;
  };
  const view: DatabaseAdapter = new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "withSchema" && typeof value === "function") return (schema: string) => tenantDatabaseView((value as (name: string) => DatabaseAdapter).call(target, schema));
      if (property === "forConnection" && typeof value === "function") return (connection: unknown) => tenantDatabaseView((value as (input: unknown) => DatabaseAdapter).call(target, connection));
      if (property === "sharesConnectionWith" && typeof value === "function") return (other: DatabaseAdapter) => other === view || other === target || (value as (other: DatabaseAdapter) => boolean).call(target, other);
      if (typeof value !== "function" || property === "transaction" || property === "listen" || property === "notify") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => (value as (...input: unknown[]) => unknown).apply(target, args.map(strip));
    },
  });
  tenantViews.set(adapter, view);
  return view;
}

/**
 * An adapter over the default database and the named ones: every call on an entity goes to the adapter of its
 * `database`, `connect` and `disconnect` reach every database, and a `transaction` belongs to the database of the
 * first entity it touches. Errors of a database carry its name as `database`.
 */
export function databaseRouter(defaultAdapter: DatabaseAdapter, named: Readonly<Record<string, DatabaseAdapter>>, options: DatabaseRouterOptions = {}): DatabaseRouter {
  // The tables of a per-tenant database's entities live where the tenant's view places them, whatever their folder.
  const placed = (name: string) => (options.tenancy?.[name] === "per-tenant" ? tenantDatabaseView(named[name]!) : named[name]!);
  return createRouter({ [DEFAULT_DATABASE]: defaultAdapter, ...Object.fromEntries(Object.keys(named).sort().map((name) => [name, placed(name)])) }, {}, options);
}

/** Whether a router database is split per tenant: the default one always, a named one by its `tenancy`. */
const perTenant = (options: DatabaseRouterOptions, name: string) => name === DEFAULT_DATABASE || options.tenancy?.[name] === "per-tenant";

/**
 * The adapter a database-strategy tenant uses: `root.forConnection(connection)`, or with named databases a router
 * whose default and per-tenant databases are the tenant's copies (each named one from its `tenantConnection`) and
 * whose shared databases are the service's own, which the tenant's adapter never connects nor closes.
 */
export async function tenantAdapter(root: DatabaseAdapter, connection: unknown, tenant: { id: string }): Promise<DatabaseAdapter> {
  if (!isDatabaseRouter(root)) return root.forConnection!(connection);
  const options = routerOptions.get(root) ?? {};
  const copies: Record<string, DatabaseAdapter> = {};
  const borrowed = new Set<string>();
  for (const [name, adapter] of Object.entries(root.databases)) {
    if (!perTenant(options, name)) {
      copies[name] = adapter;
      borrowed.add(name);
      continue;
    }
    if (name === DEFAULT_DATABASE) {
      copies[name] = adapter.forConnection!(connection);
      continue;
    }
    const template = options.tenantConnections?.[name];
    if (template === undefined) throw new Error(tenantConnectionRequired(name));
    const value = typeof template === "function" ? await template({ tenant }) : template.replaceAll("{tenant}", tenant.id);
    if (!adapter.forConnection) throw new Error(`tenancy strategy "database" needs an adapter with forConnection(); the ${adapter.kind ?? "configured"} adapter of database ${name} has none`);
    copies[name] = adapter.forConnection(value);
  }
  return createRouter(copies, {}, options, borrowed);
}

/** The startup error of a per-tenant named database without `tenantConnection` while database-strategy tenants exist. */
export const tenantConnectionRequired = (name: string) => `databases.${name}.tenantConnection is required for database-strategy tenants`;

/**
 * The problems that stop a tenancy strategy on a router's databases: a per-tenant database without `withSchema` for
 * the schema strategy, or without `tenantConnection` (or `forConnection`) for the database strategy.
 */
export function tenancyStrategyProblems(root: DatabaseAdapter, strategies: { schema: boolean; database: boolean }): string[] {
  if (!isDatabaseRouter(root)) return [];
  const options = routerOptions.get(root) ?? {};
  return Object.entries(root.databases).flatMap(([name, adapter]) => {
    if (name === DEFAULT_DATABASE || !perTenant(options, name)) return [];
    return [
      ...(strategies.schema && typeof adapter.withSchema !== "function" ? [`tenancy strategy "schema" needs an adapter with withSchema(); the ${adapter.kind ?? "configured"} adapter of database ${name} has none`] : []),
      ...(strategies.database && options.tenantConnections?.[name] === undefined ? [tenantConnectionRequired(name)] : []),
    ];
  });
}

/** The databases split per tenant, default first: the default one and, with named databases, each per-tenant one. */
export function tenantDatabaseNames(root: DatabaseAdapter): string[] {
  if (!isDatabaseRouter(root)) return [DEFAULT_DATABASE];
  const options = routerOptions.get(root) ?? {};
  return Object.keys(root.databases).filter((name) => perTenant(options, name));
}

/** The tenancy of a router's databases, for the tenant views and adapters made from it. */
const routerOptions = new WeakMap<object, DatabaseRouterOptions>();

function createRouter(databases: Record<string, DatabaseAdapter>, family: object, options: DatabaseRouterOptions, borrowed: ReadonlySet<string> = new Set()): DatabaseRouter {
  const logger = options.logger ?? jsonLogger;
  const names = Object.keys(databases);
  const defaultAdapter = databases[DEFAULT_DATABASE]!;
  const adapterOf = (model: Pick<EntityModel, "database">): DatabaseAdapter => {
    const name = databaseOf(model);
    const adapter = databases[name];
    if (!adapter) throw new Error(`Unknown database ${name} (configured: ${names.join(", ")})`);
    return adapter;
  };

  /**
   * Runs a call on an entity's database: inside the open transaction when it belongs to that database, refused with
   * `CrossDatabaseTransactionError` when the open transaction belongs to another one.
   */
  const call = async <T>(model: Pick<EntityModel, "database" | "entityName" | "perDatabase">, fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> => {
    const state = openTransaction(family);
    // A per-database table is written in the database of the open transaction.
    const name = model.perDatabase && state?.database !== undefined ? state.database : databaseOf(model);
    const adapter = databases[name] ?? adapterOf(model);
    try {
      if (state) {
        if (state.database === undefined) bind(state, name, adapter);
        if (state.database !== name) throw new CrossDatabaseTransactionError(model.entityName ?? "an entity", name, state.database!);
        return await state.run!(() => fn(adapter));
      }
      return await fn(adapter);
    } catch (error) {
      throw tagged(error, name);
    }
  };

  /** The databases that hold project entities (the default one always), which have the per-database tables. */
  let holders: string[] = [DEFAULT_DATABASE];
  /** Whether a call on `model` reads or writes every database: a per-database table outside a transaction. */
  const everywhere = (model: Pick<EntityModel, "perDatabase">) => model.perDatabase === true && !openTransaction(family) && holders.length > 1;
  /** The first result of `fn` on the databases holding a per-database table that `found` accepts. */
  const first = async <T>(model: EntityModel, fn: (adapter: DatabaseAdapter) => Promise<T>, found: (result: T) => boolean): Promise<T> => {
    let result!: T;
    for (const name of holders) {
      result = await call({ ...model, perDatabase: undefined, database: name }, fn);
      if (found(result)) return result;
    }
    return result;
  };
  /** A page of a per-database table read from every database, merged in the requested order. */
  const findEverywhere = async (model: EntityModel, query: FindManyOptions): Promise<FindManyResult> => {
    const pages = await Promise.all(
      holders.map((name) => call({ ...model, perDatabase: undefined, database: name }, (adapter) => adapter.findMany(model, { ...query, offset: 0, limit: query.offset + query.limit }))),
    );
    const order = query.sort.some((item) => item.field === "id") ? query.sort : [...query.sort, { field: "id", direction: "asc" as const }];
    const compare = (a: StoredRecord, b: StoredRecord) => {
      for (const { field, direction } of order) {
        const left = a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as number | string);
        const right = b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as number | string);
        if (left === right) continue;
        if (left === null || left === undefined) return 1;
        if (right === null || right === undefined) return -1;
        return (left < right ? -1 : 1) * (direction === "desc" ? -1 : 1);
      }
      return 0;
    };
    const data = pages.flatMap((page) => page.data).sort(compare).slice(query.offset, query.offset + query.limit);
    return { data, total: query.withTotal === false ? data.length : pages.reduce((sum, page) => sum + page.total, 0) };
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
    on: (name: string, subject?: string) => viewOn(name, subject),
    async connect(models: EntityModel[], connectOptions?: ConnectOptions) {
      modelsOf.set(family, models);
      holders = names.filter((name) => name === DEFAULT_DATABASE || models.some((model) => !model.feature && !model.system && !model.link && databaseOf(model) === name));
      const connected: DatabaseAdapter[] = [];
      for (const name of names) {
        // A tenant's adapter uses the service's shared databases as they are.
        if (borrowed.has(name)) continue;
        const adapter = databases[name]!;
        const own = databaseModels(models, name);
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
      const own = names.filter((name) => !borrowed.has(name));
      const results = await Promise.allSettled(own.map((name) => databases[name]!.disconnect()));
      const failed = results.findIndex((result) => result.status === "rejected");
      if (failed >= 0) throw tagged((results[failed] as PromiseRejectedResult).reason, own[failed]!);
    },
    findById: (entity, id, read) =>
      everywhere(entity) ? first(entity, (adapter) => adapter.findById(entity, id, read), Boolean) : call(entity, (adapter) => adapter.findById(entity, id, read)),
    findOne: (entity, where) => (everywhere(entity) ? first(entity, (adapter) => adapter.findOne(entity, where), Boolean) : call(entity, (adapter) => adapter.findOne(entity, where))),
    findMany: (entity, query) => (everywhere(entity) ? findEverywhere(entity, query) : call(entity, (adapter) => adapter.findMany(entity, query))),
    insert: (entity, record) => call(entity, (adapter) => adapter.insert(entity, record)),
    updateById: (entity, id, changes, where) =>
      everywhere(entity)
        ? first(entity, (adapter) => adapter.updateById(entity, id, changes, where), Boolean)
        : call(entity, (adapter) => adapter.updateById(entity, id, changes, where)),
    deleteById: (entity, id) => (everywhere(entity) ? first(entity, (adapter) => adapter.deleteById(entity, id), Boolean) : call(entity, (adapter) => adapter.deleteById(entity, id))),
    count: async (entity, where) => {
      if (!everywhere(entity)) return call(entity, (adapter) => adapter.count(entity, where));
      let total = 0;
      for (const name of holders) total += await call({ ...entity, perDatabase: undefined, database: name }, (adapter) => adapter.count(entity, where));
      return total;
    },
    aggregate: (entity, where, aggregates) => call(entity, (adapter) => adapter.aggregate(entity, where, aggregates)),
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (openTransaction(family)) return fn();
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
        if (borrowed.has(name)) continue;
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
  /**
   * A view whose transactions belong to `name` from the start, like `transaction(fn, { database })`; `subject` names
   * what they are for (an entity's writes) in the error of joining a transaction of another database.
   */
  const bound = new Map<string, DatabaseRouter>();
  function viewOn(name: string, subject = "a transaction"): DatabaseRouter {
    const adapter = databases[name];
    if (!adapter) throw new Error(`Unknown database ${name} (configured: ${names.join(", ")})`);
    const key = `${name}\u0000${subject}`;
    let view = bound.get(key);
    if (!view) {
      view = Object.create(router) as DatabaseRouter;
      view.transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
        const open = openTransaction(family);
        if (open) {
          joinTransactionDatabase(view!);
          return fn();
        }
        const state: RoutedTransaction = { family, database: name, run: (work) => work() };
        try {
          return await adapter.transaction(() => transactions.run(state, fn));
        } catch (error) {
          throw tagged(error, name);
        } finally {
          state.closed = true;
        }
      };
      boundDatabases.set(view, { name, subject });
      routers.add(view);
      familyOf.set(view, family);
      bound.set(key, view);
    }
    return view;
  }
  if (defaultAdapter.listen) router.listen = defaultAdapter.listen.bind(defaultAdapter);
  if (defaultAdapter.notify) router.notify = defaultAdapter.notify.bind(defaultAdapter);
  if (defaultAdapter.withSchema) {
    // A schema view moves the default database's entities into the schema; it shares the router's transactions.
    router.withSchema = (schema) => {
      views ??= new Map();
      let view = views.get(schema);
      if (!view) {
        // The default database and every per-tenant one move into the schema; shared ones stay as they are.
        const moved = Object.fromEntries(
          names.map((name) => {
            const adapter = databases[name]!;
            if (!perTenant(options, name) || borrowed.has(name)) return [name, adapter];
            if (!adapter.withSchema) throw new Error(`tenancy strategy "schema" needs an adapter with withSchema(); the ${adapter.kind ?? "configured"} adapter of database ${name} has none`);
            return [name, adapter.withSchema(schema)];
          }),
        );
        view = createRouter(moved, family, options, borrowed);
        views.set(schema, view);
      }
      return view;
    };
  }
  if (defaultAdapter.forConnection) {
    router.forConnection = (connection) => createRouter({ ...databases, [DEFAULT_DATABASE]: defaultAdapter.forConnection!(connection) }, {}, options, new Set(names.filter((name) => name !== DEFAULT_DATABASE)));
  }
  routerOptions.set(router, options);
  routers.add(router);
  familyOf.set(router, family);
  return router;
}

/** The models each router family connected with. */
const modelsOf = new WeakMap<object, readonly EntityModel[]>();

/** The models a router (or one of its views) connected its databases with; empty before it connected. */
export function connectedModels(adapter: DatabaseAdapter): readonly EntityModel[] {
  const family = familyOf.get(adapter);
  return (family && modelsOf.get(family)) ?? [];
}

/** The transaction family of each router: a router and its schema views share one. */
const familyOf = new WeakMap<object, object>();

/** The named databases already logged as holding no entity. */
const announced = new WeakSet<DatabaseAdapter>();
