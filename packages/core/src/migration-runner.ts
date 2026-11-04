/**
 * Applies migrations from any source: the project's files for the CLI, or the registry a bundle or binary carries, so
 * `<service> migrate` runs with the deployed artifact alone. Nothing here reads the project's sources, and the database
 * drivers load only when a migration runs.
 */
import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import type { ResolvedConfig } from "./config.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import type { MongodbAdapter } from "./adapters/mongodb.ts";
import type { Repositories } from "./hooks.ts";
import type { EntityModel } from "./model.ts";
import type { MigrationContext, MigrationSqlOptions } from "./migrations.ts";
import { MIGRATIONS_TABLE, renameLegacyMigrationTables, type RenamedTable } from "./legacy-names.ts";
import { databaseAdapters, DEFAULT_DATABASE, placeFeatureEntities } from "./named-databases.ts";
import { createRepositories } from "./repository.ts";
import { secretValue, type SecretReference } from "./secret-references.ts";
import { schemaIdentifier, SQLITE_DEFAULT_SCHEMA_TOKEN, sqliteDefaultPrefix, type SqlDialect } from "./sql/schema.ts";
import { registerProjectFeatures, type ProjectFeatureModule } from "./features.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";

/** The Drizzle clients migrations pass to `up` and `down`, loaded when migrations first run. */
let drizzleClients: { sqlite(client: Database): unknown; postgres(client: SQL): unknown } | undefined;

async function loadDrizzleClients(): Promise<NonNullable<typeof drizzleClients>> {
  const [sqlite, postgres] = await Promise.all([import("drizzle-orm/bun-sqlite"), import("drizzle-orm/bun-sql")]);
  drizzleClients ??= { sqlite: (client) => sqlite.drizzle(client), postgres: (client) => postgres.drizzle({ client }) };
  return drizzleClients;
}

/** A failure of the migration commands, printed with exit code 1. */
class MigrationFailure extends Error {}

/** A migration file: its id (`<YYYYMMDDHHmmss>_<Name>`), its name and its path. */
export interface MigrationFile {
  id: string;
  name: string;
  file: string;
}

export const HISTORY_TABLE = MIGRATIONS_TABLE;
const HISTORY_TABLE_NAME = HISTORY_TABLE;
export const MONGO_HISTORY_COLLECTION = "_migrations";
export const MONGO_NO_TRANSACTION_WARNING =
  "MongoDB migrations run without transactions: index changes cannot run inside one";

/** A migration that failed; carries the warnings of the run, which still apply to the migrations before it. */
export class MigrationError extends MigrationFailure {
  constructor(
    message: string,
    readonly warnings: string[],
  ) {
    super(message);
  }
}

export interface MigrateOptions {
  target?: string;
  force?: boolean;
  /** Migrates only this database (`default` or a name of `databases`). */
  database?: string;
}

export interface MigrateResult {
  applied: string[];
  reverted: string[];
  messages: string[];
  warnings: string[];
  /** Migrations tables renamed from their previous name before migrating. */
  renamed: RenamedTable[];
  /** Every step run, with its database. */
  items: { database: string; id: string; direction: Direction }[];
}

export interface AppliedMigration {
  id: string;
  name: string;
}

export type Direction = "up" | "down";
export type MigrationModule = Record<Direction, (ctx: unknown) => Promise<void>>;

/** Runs migrations and keeps their history for one database. */
export interface MigrationDriver {
  ensureHistory(): Promise<void>;
  /** Applied migrations, or an empty list when the history does not exist yet. */
  readHistory(): Promise<AppliedMigration[]>;
  /** The default schemas recorded per migration id in an explicit schema's history; empty when it does not exist. */
  readSchemaHistory(schema: string): Promise<Map<string, string[]>>;
  /** Runs one migration step and records it in the history. */
  runStep(migration: MigrationFile, direction: Direction, module: MigrationModule, repos: Repositories): Promise<void>;
  warnings: string[];
  /** Set with tenancy: tenant statements are skipped and counted. */
  tenancy?: { skipped: number };
}

function toQuery(query: TemplateStringsArray | string, values: unknown[], placeholder: (index: number) => string) {
  if (typeof query === "string") return { text: query, values };
  return { text: query.reduce((text, part, index) => text + (index > 0 ? placeholder(index) : "") + part, ""), values };
}

function isSqlOptions(value: unknown): value is MigrationSqlOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === "schema") return typeof (value as MigrationSqlOptions).schema === "string";
  return keys[0] === "shared" && (value as MigrationSqlOptions).shared === true;
}

/** Separates the `{ schema }` or `{ shared: true }` options of `ctx.sql(statement, options)` from bound values. */
export function splitSqlOptions(query: TemplateStringsArray | string, values: unknown[]): { values: unknown[]; schema?: string; shared?: true } {
  if (typeof query === "string" && values.length === 1 && isSqlOptions(values[0])) {
    const options = values[0];
    return options.schema !== undefined ? { values: [], schema: options.schema } : { values: [], shared: true };
  }
  return { values };
}

/** The history table of an explicit schema, named like that schema's tables. */
export function schemaHistoryTable(dialect: SqlDialect, schema: string): string {
  return dialect === "sqlite" ? `${sqliteDefaultPrefix(schema)}${HISTORY_TABLE_NAME}` : `"${schemaIdentifier(schema)}".${HISTORY_TABLE_NAME}`;
}

/** The migration connection inside a step's transaction. */
interface SqlRunner {
  dialect: SqlDialect;
  /** Runs a statement of a migration file, whose bound values use the dialect's placeholders. */
  statement(text: string, params: unknown[]): Promise<unknown>;
  placeholder(index: number): string;
  /** Runs an internal query written with `?` placeholders. */
  exec(text: string, params?: unknown[]): Promise<unknown>;
  rows<T>(text: string, params?: unknown[]): Promise<T[]>;
}

/** Records in explicit schemas: which default schemas applied each migration there. */
function schemaHistories(runner: SqlRunner) {
  const ensured = new Set<string>();
  const table = (schema: string) => schemaHistoryTable(runner.dialect, schema);
  return {
    async ensure(schema: string) {
      if (ensured.has(schema)) return;
      ensured.add(schema);
      if (runner.dialect === "postgres") await runner.exec(`create schema if not exists "${schemaIdentifier(schema)}"`);
      const appliedAt = runner.dialect === "sqlite" ? "integer" : "timestamptz";
      await runner.exec(
        `create table if not exists ${table(schema)} (id text primary key, name text not null, applied_at ${appliedAt} not null, default_schemas text not null)`,
      );
    },
    /** The default schemas that applied a migration in `schema`, or undefined when none did. */
    async read(schema: string, id: string): Promise<string[] | undefined> {
      const [row] = await runner.rows<{ default_schemas: string }>(`select default_schemas from ${table(schema)} where id = ?`, [id]);
      return row ? (JSON.parse(row.default_schemas) as string[]) : undefined;
    },
    async write(schema: string, migration: MigrationFile, defaultSchemas: string[], exists: boolean) {
      const value = JSON.stringify(defaultSchemas);
      if (exists) {
        await runner.exec(`update ${table(schema)} set default_schemas = ? where id = ?`, [value, migration.id]);
        return;
      }
      const now = runner.dialect === "sqlite" ? Date.now() : new Date();
      await runner.exec(`insert into ${table(schema)} (id, name, applied_at, default_schemas) values (?, ?, ?, ?)`, [
        migration.id,
        migration.name,
        now,
        value,
      ]);
    },
    async remove(schema: string, id: string) {
      await runner.exec(`delete from ${table(schema)} where id = ?`, [id]);
    },
    /** Drops the history table when no migration is recorded there any more, so the schema itself can be dropped. */
    async dropIfEmpty(schema: string) {
      const [row] = await runner.rows<{ count: number }>(`select count(*) as count from ${table(schema)}`);
      if (Number(row?.count ?? 0) === 0) await runner.exec(`drop table ${table(schema)}`);
    },
  };
}

interface SchemaRecordRow {
  id: string;
  default_schemas: string;
}

const recordsOf = (rows: SchemaRecordRow[]) => new Map(rows.map((row) => [row.id, JSON.parse(row.default_schemas) as string[]]));

const DROP_SCHEMA = /^\s*DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i;

interface SqlStep {
  runner: SqlRunner;
  /** The history table of the default schema. */
  history: string;
  /** The resolved default schema, recorded in explicit schemas' histories (`""` when there is none). */
  defaultSchema: string;
  db: unknown;
  repos: Repositories;
  /** With tenancy: the statements without a marker belong to tenants and are skipped here, counted in `skipped`. */
  tenancy?: { skipped: number };
}

/**
 * Runs one migration step: statements in their written order, then the history records. A statement marked with an
 * explicit schema changes tables every default schema shares, so applying runs it only when that schema has not
 * applied the migration yet, and reverting runs it only for the last default schema that applied it there. The
 * caller wraps the step in a transaction.
 */
async function runSqlStep(step: SqlStep, migration: MigrationFile, direction: Direction, module: MigrationModule): Promise<void> {
  const { runner } = step;
  const histories = schemaHistories(runner);
  /** Per marked schema: the default schemas recorded there before this step, and what is left after it. */
  const marked = new Map<string, { recorded: string[] | undefined; after: string[]; runs: boolean; removed: boolean }>();
  const sql = (async (query: TemplateStringsArray | string, ...values: unknown[]) => {
    const { values: params, schema, shared } = splitSqlOptions(query, values);
    if (step.tenancy && schema === undefined && !shared) {
      step.tenancy.skipped++;
      return undefined;
    }
    if (schema !== undefined) {
      let state = marked.get(schema);
      if (!state) {
        await histories.ensure(schema);
        const recorded = await histories.read(schema, migration.id);
        if (direction === "up") {
          const after = recorded?.includes(step.defaultSchema) ? recorded : [...(recorded ?? []), step.defaultSchema];
          state = { recorded, after, runs: recorded === undefined, removed: false };
        } else {
          const after = (recorded ?? []).filter((name) => name !== step.defaultSchema);
          state = { recorded, after, runs: after.length === 0, removed: false };
        }
        marked.set(schema, state);
      }
      if (!state.runs) return undefined;
      const dropped = typeof query === "string" ? DROP_SCHEMA.exec(query)?.[1] : undefined;
      if (direction === "down" && dropped === schemaIdentifier(schema) && !state.removed) {
        // The history table lives in the schema: it has to go first for the schema to be dropped.
        await histories.remove(schema, migration.id);
        await histories.dropIfEmpty(schema);
        state.removed = true;
      }
    }
    const { text, values: bound } = toQuery(query, params, runner.placeholder);
    return runner.statement(text, bound);
  }) as MigrationContext["sql"];
  await module[direction]({ sql, db: step.db, repos: step.repos } satisfies MigrationContext);
  if (direction === "down") await runner.exec(`delete from ${step.history} where id = ?`, [migration.id]);
  else {
    const now = runner.dialect === "sqlite" ? Date.now() : new Date();
    await runner.exec(`insert into ${step.history} (id, name, applied_at) values (?, ?, ?)`, [migration.id, migration.name, now]);
  }
  for (const [schema, { recorded, after, removed }] of marked) {
    if (removed) continue;
    if (after.length > 0) await histories.write(schema, migration, after, recorded !== undefined);
    else if (recorded !== undefined) await histories.remove(schema, migration.id);
  }
}

function sqliteDriver(client: Database, defaultSchema: string | null): MigrationDriver {
  const prefix = sqliteDefaultPrefix(defaultSchema);
  const HISTORY_TABLE = `${prefix}${HISTORY_TABLE_NAME}`;
  const resolve = (text: string) => text.replaceAll(SQLITE_DEFAULT_SCHEMA_TOKEN, prefix);
  const runner: SqlRunner = {
    dialect: "sqlite",
    placeholder: () => "?",
    async statement(text, params) {
      return client.run(resolve(text), params as never[]);
    },
    async exec(text, params = []) {
      return client.run(text, params as never[]);
    },
    async rows<T>(text: string, params: unknown[] = []) {
      return client.query(text).all(...(params as never[])) as T[];
    },
  };
  const db = drizzleClients!.sqlite(client);
  const driver: MigrationDriver = {
    warnings: [],
    async ensureHistory() {
      client.run(`create table if not exists ${HISTORY_TABLE} (id text primary key, name text not null, applied_at integer not null)`);
    },
    async readHistory() {
      const exists = client.query("select name from sqlite_master where type = 'table' and name = ?").get(HISTORY_TABLE);
      return exists ? (client.query(`select id, name from ${HISTORY_TABLE} order by id`).all() as AppliedMigration[]) : [];
    },
    async readSchemaHistory(schema) {
      const table = schemaHistoryTable("sqlite", schema);
      if (!client.query("select name from sqlite_master where type = 'table' and name = ?").get(table)) return new Map();
      return recordsOf(client.query(`select id, default_schemas from ${table}`).all() as SchemaRecordRow[]);
    },
    async runStep(migration, direction, module, repos) {
      client.run("begin");
      try {
        const step = { runner, history: HISTORY_TABLE, defaultSchema: defaultSchema ?? "", db, repos, ...(driver.tenancy ? { tenancy: driver.tenancy } : {}) };
        await runSqlStep(step, migration, direction, module);
        client.run("commit");
      } catch (error) {
        client.run("rollback");
        throw error;
      }
    },
  };
  return driver;
}

function postgresDriver(client: SQL, defaultSchema: string | null): MigrationDriver {
  const db = drizzleClients!.postgres(client);
  const driver: MigrationDriver = {
    warnings: [],
    async ensureHistory() {
      // quickservicets-allow-unsafe: the history table name is a constant
      await client.unsafe(
        `create table if not exists ${HISTORY_TABLE} (id text primary key, name text not null, applied_at timestamptz not null)`,
      );
    },
    async readHistory() {
      const [row] = (await client.unsafe("select to_regclass($1) as found", [HISTORY_TABLE])) as { found: string | null }[];
      if (!row?.found) return [];
      // quickservicets-allow-unsafe: the history table name is a constant
      return (await client.unsafe(`select id, name from ${HISTORY_TABLE} order by id`)) as AppliedMigration[];
    },
    async readSchemaHistory(schema) {
      const table = schemaHistoryTable("postgres", schema);
      const [row] = (await client.unsafe("select to_regclass($1) as found", [table])) as { found: string | null }[];
      if (!row?.found) return new Map();
      // quickservicets-allow-unsafe: the table name is built by schemaHistoryTable from a validated schema name
      return recordsOf((await client.unsafe(`select id, default_schemas from ${table}`)) as SchemaRecordRow[]);
    },
    async runStep(migration, direction, module, repos) {
      await client.begin(async (tx) => {
        const numbered = (text: string) => {
          let index = 0;
          return text.replace(/\?/g, () => `$${++index}`);
        };
        const runner: SqlRunner = {
          dialect: "postgres",
          placeholder: (index) => `$${index}`,
          // quickservicets-allow-unsafe: runs the statements of migration files, with their values as parameters
          statement: (text, params) => tx.unsafe(text, params),
          // quickservicets-allow-unsafe: runs the statements of migration files, with their values as parameters
          exec: (text, params = []) => tx.unsafe(numbered(text), params),
          // quickservicets-allow-unsafe: runs the statements of migration files, with their values as parameters
          rows: async <T>(text: string, params: unknown[] = []) => (await tx.unsafe(numbered(text), params)) as T[],
        };
        const step = { runner, history: HISTORY_TABLE, defaultSchema: defaultSchema ?? "", db, repos, ...(driver.tenancy ? { tenancy: driver.tenancy } : {}) };
        await runSqlStep(step, migration, direction, module);
      });
    },
  };
  return driver;
}

function mongoDriver(adapter: MongodbAdapter): MigrationDriver {
  const db = (schema?: string) => adapter.databaseFor(schema);
  const history = () => db().collection<{ _id: string; name: string; appliedAt: Date }>(MONGO_HISTORY_COLLECTION);
  const driver: MigrationDriver = {
    warnings: [],
    async ensureHistory() {},
    async readHistory() {
      const rows = await history().find().sort({ _id: 1 }).toArray();
      return rows.map((row) => ({ id: row._id, name: row.name }));
    },
    async readSchemaHistory() {
      return new Map();
    },
    async runStep(migration, direction, module, repos) {
      if (driver.warnings.length === 0) driver.warnings.push(MONGO_NO_TRANSACTION_WARNING);
      await module[direction]({ db, client: adapter.client!, repos });
      if (direction === "up") await history().insertOne({ _id: migration.id, name: migration.name, appliedAt: new Date() });
      else await history().deleteOne({ _id: migration.id });
    },
  };
  return driver;
}

function driverFor(config: ResolvedConfig, adapter: DatabaseAdapter = config.database): MigrationDriver {
  const raw = adapter as { kind?: string; client?: unknown };
  const tenancy = config.features.some((feature) => feature.key === "tenancy");
  const withTenancy = (driver: MigrationDriver) => (tenancy ? Object.assign(driver, { tenancy: { skipped: 0 } }) : driver);
  if (raw.kind === "sqlite") return withTenancy(sqliteDriver(raw.client as Database, config.schema));
  if (raw.kind === "postgres") return withTenancy(postgresDriver(raw.client as SQL, config.schema));
  if (raw.kind === "mongodb") return mongoDriver(adapter as MongodbAdapter);
  throw new MigrationFailure(`Migrations are not supported for the ${raw.kind ?? "configured"} adapter`);
}

function resolveTarget(target: string, files: MigrationFile[]): string {
  if (target === "0") return "0";
  const match = files.find((file) => file.id === target || file.name === target);
  if (!match) throw new MigrationFailure(`Unknown migration target: ${target}`);
  return match.id;
}

interface Step {
  migration: MigrationFile;
  direction: Direction;
}

function planSteps(files: MigrationFile[], applied: AppliedMigration[], target: string | undefined): Step[] {
  const appliedIds = new Set(applied.map((migration) => migration.id));
  const byId = new Map(files.map((file) => [file.id, file]));
  const targetId = target === undefined ? undefined : resolveTarget(target, files);
  if (targetId === undefined) {
    return files.filter((file) => !appliedIds.has(file.id)).map((migration) => ({ migration, direction: "up" }));
  }
  const downs = [...applied]
    .reverse()
    .filter((migration) => targetId === "0" || migration.id > targetId)
    .map((migration) => ({ migration: byId.get(migration.id)!, direction: "down" as const }));
  const ups =
    targetId === "0"
      ? []
      : files.filter((file) => !appliedIds.has(file.id) && file.id <= targetId).map((migration) => ({ migration, direction: "up" as const }));
  return [...downs, ...ups];
}

/** One database a migration runs on: its name, adapter, migration driver and migration files. */
export interface DatabaseDriver {
  database: string;
  adapter: DatabaseAdapter;
  driver: MigrationDriver;
  files: MigrationFile[];
}


/** Where migrations come from: the resolved config, the models, each database's migration files and how to load one. */
export interface MigrationSource {
  config: ResolvedConfig;
  models: EntityModel[];
  /** The migration files of a database (`default` or a name of `databases`), oldest first. */
  files(database: string): MigrationFile[];
  load(file: MigrationFile): Promise<MigrationModule>;
}

/**
 * The config migrations run with: when `connections.direct` is set and the database is a PostgreSQL adapter, the
 * database is the direct connection, since migrations hold locks and run DDL across statements that a connection
 * proxy in transaction mode would split.
 */
export function migrationConfig(config: ResolvedConfig): ResolvedConfig {
  const direct = (config.features.find((feature) => feature.key === "connections")?.options as { direct?: string | SecretReference } | undefined)?.direct;
  const adapter = config.database;
  if (direct === undefined || adapter.kind !== "postgres" || typeof adapter.forConnection !== "function") return config;
  return { ...config, database: adapter.forConnection(secretValue(direct)) };
}

/**
 * Connects the configured databases and runs `work` with one driver per database that keeps a schema, default first
 * then by name (only `database` when given); memory databases are left out.
 */
export async function withSourceDrivers<T>(source: MigrationSource, work: (drivers: DatabaseDriver[], config: ResolvedConfig, named: boolean) => Promise<T>, database?: string): Promise<T> {
  const { models } = source;
  const config = migrationConfig(source.config);
  const all = databaseAdapters(config.database);
  if (database !== undefined && !all.some(([name]) => name === database)) {
    throw new MigrationFailure(`Unknown database ${database} (configured: ${all.map(([name]) => name).join(", ")})`);
  }
  const chosen = all.filter(([name, adapter]) => adapter.kind !== "memory" && (database === undefined || name === database));
  if (chosen.length === 0) throw new MigrationFailure("Migrations are not used with the memory adapter");
  await loadDrizzleClients();
  await config.database.connect(models, { defaultSchema: config.schema });
  try {
    const drivers = chosen.map(([name, adapter]) => ({ database: name, adapter, driver: driverFor(config, adapter), files: source.files(name) }));
    return await work(drivers, config, all.length > 1);
  } finally {
    await config.database.disconnect();
  }
}

/** Applies the pending migrations of every database of a source, or migrates up or down to a target. */
export async function applyMigrations(source: MigrationSource, options: MigrateOptions = {}): Promise<MigrateResult> {
  if (databaseAdapters(source.config.database).every(([, adapter]) => adapter.kind === "memory")) {
    return { applied: [], reverted: [], warnings: [], renamed: [], items: [], messages: ["Nothing to migrate: the memory adapter keeps no schema"] };
  }
  return withSourceDrivers(
    source,
    async (drivers, resolved, named) => {
      // A target names one database's migration: a name several folders have needs --database.
      if (options.target !== undefined && options.target !== "0" && options.database === undefined && named) {
        const holders = drivers.filter(({ files }) => files.some((file) => file.id === options.target || file.name === options.target));
        if (holders.length > 1) throw new MigrationFailure(`Migration target ${options.target} exists in databases ${holders.map(({ database }) => database).join(", ")}; pass --database <name>`);
        if (holders.length === 1) drivers = holders;
      }
      const label = (database: string, text: string) => (named ? `${database}: ${text}` : text);
      const plans: { entry: DatabaseDriver; steps: Step[] }[] = [];
      const renamed: RenamedTable[] = [];
      for (const entry of drivers) {
        renamed.push(...(await renameLegacyMigrationTables(entry.adapter as { kind?: string; client?: unknown })));
        await entry.driver.ensureHistory();
        const applied = await entry.driver.readHistory();
        const missing = applied.filter((migration) => !entry.files.some((file) => file.id === migration.id));
        if (missing.length > 0) {
          throw new MigrationFailure(label(entry.database, `Applied migrations are missing on disk: ${missing.map((migration) => migration.id).join(", ")}`));
        }
        plans.push({ entry, steps: planSteps(entry.files, applied, options.target) });
      }
      const downs = plans.flatMap(({ steps }) => steps.filter((step) => step.direction === "down"));
      if (resolved.production && downs.length > 0 && !options.force) {
        throw new MigrationFailure(
          `Reverting migrations in production requires --force (would revert: ${downs.map((step) => step.migration.id).join(", ")})`,
        );
      }

      const repos = createRepositories(source.models, resolved.database) as unknown as Repositories;
      const warnings = [...new Set(drivers.flatMap(({ driver }) => driver.warnings))];
      const result: MigrateResult = { applied: [], reverted: [], messages: [], warnings, renamed, items: [] };
      for (const { entry, steps } of plans) {
        for (const { migration, direction } of steps) {
          const module = await source.load(migration);
          try {
            await entry.driver.runStep(migration, direction, module, repos);
          } catch (error) {
            const where = named ? ` in database ${entry.database}` : "";
            throw new MigrationError(`Migration ${migration.id} failed${where}: ${error instanceof Error ? error.message : String(error)}`, [...new Set([...warnings, ...entry.driver.warnings])]);
          }
          (direction === "up" ? result.applied : result.reverted).push(migration.id);
          result.items.push({ database: entry.database, id: migration.id, direction });
          result.messages.push(label(entry.database, `${direction === "up" ? "Applied" : "Reverted"} ${migration.id}`));
        }
        if (named && steps.length === 0) result.messages.push(label(entry.database, "Database is up to date (0 migrations applied)"));
      }
      result.warnings = [...new Set(drivers.flatMap(({ driver }) => driver.warnings))];
      if (!named && plans.every(({ steps }) => steps.length === 0)) result.messages.push("Database is up to date (0 migrations applied)");
      const skipped = drivers.reduce((sum, { driver }) => sum + (driver.tenancy?.skipped ?? 0), 0);
      if (drivers.some(({ driver }) => driver.tenancy) && skipped > 0) result.messages.push(`Skipped ${skipped} tenant statements; run quickservicets migrate --all-tenants`);
      return result;
    },
    options.database,
  );
}

export interface BundledMigration {
  id: string;
  name: string;
  file: string;
  load(): Promise<unknown>;
}

/** What `runMigrations` takes: the generated inputs of the service. */
export interface BundledMigrationInputs {
  projectConfig: ServiceConfig;
  models: EntityModel[];
  features?: readonly ProjectFeatureModule[];
  /** The registered migrations, by database (`default` or a name of `databases`). */
  migrations: Readonly<Record<string, readonly BundledMigration[]>>;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Applies the pending migrations of every database and resolves the exit code: 0, or 1 after printing the failure. */
export async function runMigrations({ projectConfig, models, features = [], migrations, env = process.env, log = console.log, error = console.error }: BundledMigrationInputs): Promise<number> {
  registerProjectFeatures(features);
  const config = resolveConfig(projectConfig, env);
  const placed = placeFeatureEntities(models, config.features);
  const byFile = new Map(Object.values(migrations).flatMap((list) => list.map((entry) => [entry.file, entry] as const)));
  try {
    const result = await applyMigrations({
      config,
      models: placed,
      files: (database) => (migrations[database] ?? []).map(({ id, name, file }) => ({ id, name, file })),
      load: async (file) => (await byFile.get(file.file)!.load()) as MigrationModule,
    });
    for (const warning of result.warnings) error(`Warning: ${warning}`);
    for (const message of result.messages) log(message);
    return 0;
  } catch (failure) {
    if (failure instanceof MigrationError) for (const warning of failure.warnings) error(`Warning: ${warning}`);
    error(failure instanceof Error ? failure.message : String(failure));
    return 1;
  }
}
