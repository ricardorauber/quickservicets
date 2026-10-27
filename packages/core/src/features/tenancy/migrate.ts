import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createRepositories,
  MIGRATIONS_TABLE,
  schemaIdentifier,
  SQLITE_DEFAULT_SCHEMA_TOKEN,
  sqliteDefaultPrefix,
  type DatabaseAdapter,
  type EntityModel,
  type MigrationSqlOptions,
  type MongodbAdapter,
} from "../public.ts";
import { stagingTableStatement } from "./relay.ts";

/** The MongoDB collection holding a database's migration history. */
export const MONGO_MIGRATIONS_COLLECTION = "_migrations";

/** One migration file of the project. */
export interface TenantMigrationFile {
  id: string;
  name: string;
  file: string;
}

/** The migration files of a project, oldest first. */
export function migrationFiles(projectRoot: string): TenantMigrationFile[] {
  const dir = join(projectRoot, "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => /^\d{14}_[A-Z][A-Za-z0-9]*\.ts$/.test(entry))
    .sort()
    .map((entry) => ({ id: entry.slice(0, -3), name: entry.slice(15, -3), file: join(dir, entry) }));
}

/** Whether a statement's options mark it as not a tenant statement: an explicit schema's or a shared model's. */
export function isMarked(values: unknown[]): boolean {
  if (values.length !== 1) return false;
  const options = values[0] as Partial<MigrationSqlOptions> | null;
  return typeof options === "object" && options !== null && !Array.isArray(options) && (typeof options.schema === "string" || options.shared === true);
}

/** Where a tenant's tables live, for its migrations. */
export interface TenantMigrationTarget {
  /** The adapter of the tenant's database: a schema view of the root adapter, or the tenant's own connected adapter. */
  adapter: DatabaseAdapter;
  /** The tenant's schema (schema strategy), or undefined for a database of its own. */
  schema?: string;
  /** The models stored in tenant databases, for the migrations' `ctx.repos`. */
  models: readonly EntityModel[];
  /** The staging tables a database of its own needs for the relay of queue and outbox rows (created if missing). */
  staging?: readonly EntityModel[];
}

export interface TenantMigrationResult {
  applied: string[];
}

type Module = { up: (ctx: unknown) => Promise<void> };
type Runner = { run(text: string, values: unknown[]): Promise<unknown>; inTransaction<T>(fn: () => Promise<T>): Promise<T> };

const toText = (query: TemplateStringsArray | string, placeholder: (index: number) => string) =>
  typeof query === "string" ? query : query.reduce((text, part, index) => text + (index > 0 ? placeholder(index) : "") + part, "");

/**
 * Applies the tenant statements (those without `{ schema }` or `{ shared: true }`) of every pending migration to one
 * tenant, keeping its history next to its tables: in its schema of the service's database, or in its own database.
 */
export async function migrateTenantDatabase(projectRoot: string, target: TenantMigrationTarget): Promise<TenantMigrationResult> {
  const files = migrationFiles(projectRoot);
  const adapter = target.adapter;
  const repos = createRepositories([...target.models], adapter);
  const applied: string[] = [];
  if (adapter.kind === "memory" || adapter.kind === undefined) return { applied };
  if (adapter.kind === "mongodb") {
    const mongo = adapter as MongodbAdapter;
    const db = mongo.databaseFor(target.schema ?? null);
    // The history collection marks the tenant database as provisioned, even before its first migration.
    if ((await db.listCollections({ name: MONGO_MIGRATIONS_COLLECTION }).toArray()).length === 0) await db.createCollection(MONGO_MIGRATIONS_COLLECTION);
    const history = db.collection<{ _id: string; name: string; appliedAt: Date }>(MONGO_MIGRATIONS_COLLECTION);
    const done = new Set((await history.find().toArray()).map((row) => row._id));
    for (const migration of files) {
      if (done.has(migration.id)) continue;
      const module = (await import(migration.file)) as Module;
      await module.up({ db: (schema?: string) => (schema ? mongo.databaseFor(schema) : db), client: mongo.client, repos });
      await history.insertOne({ _id: migration.id, name: migration.name, appliedAt: new Date() });
      applied.push(migration.id);
    }
    return { applied };
  }
  const client = (adapter as { client?: unknown }).client as {
    run?: (text: string, params?: unknown[]) => unknown;
    query?: (text: string) => { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
    unsafe?: (text: string, params?: unknown[]) => Promise<unknown>;
    begin?: <T>(fn: (tx: { unsafe(text: string, params?: unknown[]): Promise<unknown> }) => Promise<T>) => Promise<T>;
  };
  // One SQLite file is one connection: tenants sharing it migrate one after the other.
  if (adapter.kind === "sqlite") {
    const result = await serially(client, () => migrateSqlite(files, client, adapter, target.schema, repos));
    for (const model of target.staging ?? []) client.run!(stagingTableStatement(model, "sqlite"));
    return result;
  }
  if (adapter.kind === "postgres") {
    const schema = target.schema ? schemaIdentifier(target.schema) : undefined;
    const table = schema ? `"${schema}".${MIGRATIONS_TABLE}` : MIGRATIONS_TABLE;
    // quickservicets-allow-unsafe: the schema name is checked against ^[a-z][a-z0-9-]*$ and the table name is a constant
    if (schema) await client.unsafe!(`create schema if not exists "${schema}"`);
    // quickservicets-allow-unsafe: the history table name is built from a checked schema name and a constant
    await client.unsafe!(`create table if not exists ${table} (id text primary key, name text not null, applied_at timestamptz not null)`);
    // quickservicets-allow-unsafe: the history table name is built from a checked schema name and a constant
    const done = new Set(((await client.unsafe!(`select id from ${table}`)) as { id: string }[]).map((row) => row.id));
    for (const migration of files) {
      if (done.has(migration.id)) continue;
      await client.begin!(async (tx) => {
        // The tenant's unqualified tables are its schema's for the statements of this transaction.
        // quickservicets-allow-unsafe: the schema name is checked against ^[a-z][a-z0-9-]*$
        if (schema) await tx.unsafe(`set local search_path to "${schema}"`);
        // quickservicets-allow-unsafe: runs the statements of migration files, with their values as parameters
        const runner: Runner = { run: (text, values) => tx.unsafe(text, values), inTransaction: (fn) => fn() };
        await runUp(migration, runner, (index) => `$${index}`, repos);
        // quickservicets-allow-unsafe: the history table name is built from a checked schema name and a constant
        await tx.unsafe(`insert into ${table} (id, name, applied_at) values ($1, $2, $3)`, [migration.id, migration.name, new Date()]);
      });
      applied.push(migration.id);
    }
    // quickservicets-allow-unsafe: the statement is built from the core's own staging models
    for (const model of target.staging ?? []) await client.unsafe!(stagingTableStatement(model, "postgres"));
    return { applied };
  }
  throw new Error(`Tenant migrations are not supported for the ${adapter.kind} adapter`);
}

type SqliteClient = {
  run?: (text: string, params?: unknown[]) => unknown;
  query?: (text: string) => { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
};

/** The work queued on each SQLite connection, so one runs at a time. */
const queues = new WeakMap<object, Promise<unknown>>();

/** Runs `work` after the work queued before on `client`. */
function serially<T>(client: object, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(client) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(client, next.catch(() => undefined));
  return next;
}

/** The SQLite part of `migrateTenantDatabase`: the tenant's tables carry its schema prefix (none for its own file). */
async function migrateSqlite(files: TenantMigrationFile[], client: SqliteClient, adapter: DatabaseAdapter, schema: string | undefined, repos: unknown): Promise<TenantMigrationResult> {
  const applied: string[] = [];
  const prefix = sqliteDefaultPrefix(schema);
  const table = `${prefix}${MIGRATIONS_TABLE}`;
  client.run!(`create table if not exists ${table} (id text primary key, name text not null, applied_at integer not null)`);
  const done = new Set((client.query!(`select id from ${table}`).all() as { id: string }[]).map((row) => row.id));
  const runner: Runner = {
    run: async (text, values) => client.run!(text.replaceAll(SQLITE_DEFAULT_SCHEMA_TOKEN, prefix), values),
    // The adapter's transactions take the connection one at a time, also against a running service's requests.
    inTransaction: (fn) => adapter.transaction(fn),
  };
  for (const migration of files) {
    if (done.has(migration.id)) continue;
    await runner.inTransaction(async () => {
      await runUp(migration, runner, () => "?", repos);
      client.run!(`insert into ${table} (id, name, applied_at) values (?, ?, ?)`, [migration.id, migration.name, Date.now()]);
    });
    applied.push(migration.id);
  }
  return { applied };
}

/** Runs the `up` of a migration with only its tenant statements. */
async function runUp(migration: TenantMigrationFile, runner: Runner, placeholder: (index: number) => string, repos: unknown): Promise<void> {
  const module = (await import(migration.file)) as Module;
  const sql = async (query: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof query === "string" && isMarked(values)) return undefined;
    return runner.run(toText(query, placeholder), typeof query === "string" ? values : values);
  };
  await module.up({ sql, db: undefined, repos });
}

/** The ids of the migrations a tenant has applied, or an empty list before its first migration. */
export async function appliedTenantMigrations(target: Omit<TenantMigrationTarget, "models">): Promise<string[]> {
  const adapter = target.adapter;
  if (adapter.kind === "mongodb") {
    const db = (adapter as MongodbAdapter).databaseFor(target.schema ?? null);
    return (await db.collection<{ _id: string }>(MONGO_MIGRATIONS_COLLECTION).find().toArray()).map((row) => row._id);
  }
  const client = (adapter as { client?: { query?: (text: string) => { all(): unknown[]; get(...params: unknown[]): unknown }; unsafe?: (text: string, params?: unknown[]) => Promise<unknown> } }).client;
  if (adapter.kind === "sqlite") {
    const table = `${sqliteDefaultPrefix(target.schema)}${MIGRATIONS_TABLE}`;
    if (!client!.query!("select name from sqlite_master where type = 'table' and name = ?").get(table)) return [];
    return (client!.query!(`select id from ${table}`).all() as { id: string }[]).map((row) => row.id);
  }
  if (adapter.kind === "postgres") {
    const table = target.schema ? `"${schemaIdentifier(target.schema)}".${MIGRATIONS_TABLE}` : MIGRATIONS_TABLE;
    const [row] = (await client!.unsafe!("select to_regclass($1) as found", [table])) as { found: string | null }[];
    if (!row?.found) return [];
    // quickservicets-allow-unsafe: the history table name is built from a checked schema name and a constant
    return ((await client!.unsafe!(`select id from ${table}`)) as { id: string }[]).map((item) => item.id);
  }
  return [];
}
