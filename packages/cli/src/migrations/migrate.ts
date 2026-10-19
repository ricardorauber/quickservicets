import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import {
  createRepositories,
  loadConfig,
  schemaIdentifier,
  SQLITE_DEFAULT_SCHEMA_TOKEN,
  sqliteDefaultPrefix,
  type MigrationContext,
  type MigrationSqlOptions,
  type MongodbAdapter,
  type Repositories,
  type ResolvedConfig,
  type SqlDialect,
} from "@quickservice/core";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzlePostgres } from "drizzle-orm/bun-sql";
import { parseProjectEntities as parseEntities } from "../entities/parse-entities.ts";
import { BuildError } from "../errors.ts";
import { listMigrations, type MigrationFile } from "./snapshot.ts";

export const HISTORY_TABLE = "__quickservice_migrations";
const HISTORY_TABLE_NAME = HISTORY_TABLE;
export const MONGO_HISTORY_COLLECTION = "_migrations";
export const MONGO_NO_TRANSACTION_WARNING =
  "MongoDB migrations run without transactions: index changes cannot run inside one";

/** A migration that failed; carries the warnings of the run, which still apply to the migrations before it. */
export class MigrationError extends BuildError {
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
}

export interface MigrateResult {
  applied: string[];
  reverted: string[];
  messages: string[];
  warnings: string[];
}

export interface AppliedMigration {
  id: string;
  name: string;
}

type Direction = "up" | "down";
type MigrationModule = Record<Direction, (ctx: unknown) => Promise<void>>;

/** Runs migrations and keeps their history for one database. */
interface MigrationDriver {
  ensureHistory(): Promise<void>;
  /** Applied migrations, or an empty list when the history does not exist yet. */
  readHistory(): Promise<AppliedMigration[]>;
  /** The default schemas recorded per migration id in an explicit schema's history; empty when it does not exist. */
  readSchemaHistory(schema: string): Promise<Map<string, string[]>>;
  /** Runs one migration step and records it in the history. */
  runStep(migration: MigrationFile, direction: Direction, module: MigrationModule, repos: Repositories): Promise<void>;
  warnings: string[];
}

function toQuery(query: TemplateStringsArray | string, values: unknown[], placeholder: (index: number) => string) {
  if (typeof query === "string") return { text: query, values };
  return { text: query.reduce((text, part, index) => text + (index > 0 ? placeholder(index) : "") + part, ""), values };
}

function isSqlOptions(value: unknown): value is MigrationSqlOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "schema" && typeof (value as MigrationSqlOptions).schema === "string";
}

/** Separates the `{ schema }` options of `ctx.sql(statement, { schema })` from bound values. */
export function splitSqlOptions(query: TemplateStringsArray | string, values: unknown[]): { values: unknown[]; schema?: string } {
  if (typeof query === "string" && values.length === 1 && isSqlOptions(values[0])) return { values: [], schema: values[0].schema };
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
    const { values: params, schema } = splitSqlOptions(query, values);
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
  const db = drizzleSqlite(client);
  return {
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
        const step = { runner, history: HISTORY_TABLE, defaultSchema: defaultSchema ?? "", db, repos };
        await runSqlStep(step, migration, direction, module);
        client.run("commit");
      } catch (error) {
        client.run("rollback");
        throw error;
      }
    },
  };
}

function postgresDriver(client: SQL, defaultSchema: string | null): MigrationDriver {
  const db = drizzlePostgres({ client });
  return {
    warnings: [],
    async ensureHistory() {
      await client.unsafe(
        `create table if not exists ${HISTORY_TABLE} (id text primary key, name text not null, applied_at timestamptz not null)`,
      );
    },
    async readHistory() {
      const [row] = (await client.unsafe("select to_regclass($1) as found", [HISTORY_TABLE])) as { found: string | null }[];
      return row?.found ? ((await client.unsafe(`select id, name from ${HISTORY_TABLE} order by id`)) as AppliedMigration[]) : [];
    },
    async readSchemaHistory(schema) {
      const table = schemaHistoryTable("postgres", schema);
      const [row] = (await client.unsafe("select to_regclass($1) as found", [table])) as { found: string | null }[];
      if (!row?.found) return new Map();
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
          statement: (text, params) => tx.unsafe(text, params),
          exec: (text, params = []) => tx.unsafe(numbered(text), params),
          rows: async <T>(text: string, params: unknown[] = []) => (await tx.unsafe(numbered(text), params)) as T[],
        };
        const step = { runner, history: HISTORY_TABLE, defaultSchema: defaultSchema ?? "", db, repos };
        await runSqlStep(step, migration, direction, module);
      });
    },
  };
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

function driverFor(config: ResolvedConfig): MigrationDriver {
  const adapter = config.database as { kind?: string; client?: unknown };
  if (adapter.kind === "sqlite") return sqliteDriver(adapter.client as Database, config.schema);
  if (adapter.kind === "postgres") return postgresDriver(adapter.client as SQL, config.schema);
  if (adapter.kind === "mongodb") return mongoDriver(config.database as MongodbAdapter);
  throw new BuildError(`Migrations are not supported for the ${adapter.kind ?? "configured"} adapter`);
}

function resolveTarget(target: string, files: MigrationFile[]): string {
  if (target === "0") return "0";
  const match = files.find((file) => file.id === target || file.name === target);
  if (!match) throw new BuildError(`Unknown migration target: ${target}`);
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

async function withDriver<T>(projectRoot: string, work: (driver: MigrationDriver, config: ResolvedConfig) => Promise<T>): Promise<T> {
  const config = await loadConfig(projectRoot);
  if (config.database.kind === "memory") throw new BuildError("Migrations are not used with the memory adapter");
  const models = parseEntities(projectRoot);
  await config.database.connect(models, { defaultSchema: config.schema });
  try {
    return await work(driverFor(config), config);
  } finally {
    await config.database.disconnect();
  }
}

/** Reads the applied migrations of the configured database without changing it. */
export function readAppliedMigrations(projectRoot: string): Promise<AppliedMigration[]> {
  return withDriver(projectRoot, (driver) => driver.readHistory());
}

export interface MigrationHistory {
  applied: AppliedMigration[];
  /** Per explicit schema, the default schemas that applied each migration there. */
  schemas: Map<string, Map<string, string[]>>;
}

/** Reads the default schema's history and the histories of the given explicit schemas without changing them. */
export function readMigrationHistory(projectRoot: string, schemas: string[]): Promise<MigrationHistory> {
  return withDriver(projectRoot, async (driver) => {
    const records = new Map<string, Map<string, string[]>>();
    for (const schema of schemas) records.set(schema, await driver.readSchemaHistory(schema));
    return { applied: await driver.readHistory(), schemas: records };
  });
}

/** `quickservice migrate [target] [--force]` */
export async function migrate(projectRoot: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  const config = await loadConfig(projectRoot);
  if (config.database.kind === "memory") {
    return { applied: [], reverted: [], warnings: [], messages: ["Nothing to migrate: the memory adapter keeps no schema"] };
  }
  return withDriver(projectRoot, async (driver, resolved) => {
    await driver.ensureHistory();
    const files = listMigrations(projectRoot);
    const applied = await driver.readHistory();
    const missing = applied.filter((migration) => !files.some((file) => file.id === migration.id));
    if (missing.length > 0) {
      throw new BuildError(`Applied migrations are missing on disk: ${missing.map((migration) => migration.id).join(", ")}`);
    }
    const steps = planSteps(files, applied, options.target);
    const downs = steps.filter((step) => step.direction === "down");
    if (resolved.production && downs.length > 0 && !options.force) {
      throw new BuildError(
        `Reverting migrations in production requires --force (would revert: ${downs.map((step) => step.migration.id).join(", ")})`,
      );
    }

    const repos = createRepositories(parseEntities(projectRoot), resolved.database) as unknown as Repositories;
    const result: MigrateResult = { applied: [], reverted: [], messages: [], warnings: driver.warnings };
    for (const { migration, direction } of steps) {
      const module = (await import(migration.file)) as MigrationModule;
      try {
        await driver.runStep(migration, direction, module, repos);
      } catch (error) {
        throw new MigrationError(`Migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`, driver.warnings);
      }
      (direction === "up" ? result.applied : result.reverted).push(migration.id);
      result.messages.push(`${direction === "up" ? "Applied" : "Reverted"} ${migration.id}`);
    }
    if (steps.length === 0) result.messages.push("Database is up to date (0 migrations applied)");
    return result;
  });
}
