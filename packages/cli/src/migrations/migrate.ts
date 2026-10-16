import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import {
  createRepositories,
  loadConfig,
  SQLITE_DEFAULT_SCHEMA_TOKEN,
  sqliteDefaultPrefix,
  type MigrationContext,
  type MongodbAdapter,
  type Repositories,
  type ResolvedConfig,
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
  /** Runs one migration step and records it in the history. */
  runStep(migration: MigrationFile, direction: Direction, module: MigrationModule, repos: Repositories): Promise<void>;
  warnings: string[];
}

function toQuery(query: TemplateStringsArray | string, values: unknown[], placeholder: (index: number) => string) {
  if (typeof query === "string") return { text: query, values };
  return { text: query.reduce((text, part, index) => text + (index > 0 ? placeholder(index) : "") + part, ""), values };
}

function sqliteDriver(client: Database, defaultSchema: string | null): MigrationDriver {
  const prefix = sqliteDefaultPrefix(defaultSchema);
  const HISTORY_TABLE = `${prefix}${HISTORY_TABLE_NAME}`;
  const sql = (async (query: TemplateStringsArray | string, ...values: unknown[]) => {
    const { text, values: params } = toQuery(query, values, () => "?");
    return client.run(text.replaceAll(SQLITE_DEFAULT_SCHEMA_TOKEN, prefix), params as never[]);
  }) as MigrationContext["sql"];
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
    async runStep(migration, direction, module, repos) {
      client.run("begin");
      try {
        await module[direction]({ sql, db, repos } satisfies MigrationContext);
        if (direction === "up") {
          client.run(`insert into ${HISTORY_TABLE} (id, name, applied_at) values (?, ?, ?)`, [migration.id, migration.name, Date.now()]);
        } else {
          client.run(`delete from ${HISTORY_TABLE} where id = ?`, [migration.id]);
        }
        client.run("commit");
      } catch (error) {
        client.run("rollback");
        throw error;
      }
    },
  };
}

function postgresDriver(client: SQL): MigrationDriver {
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
    async runStep(migration, direction, module, repos) {
      await client.begin(async (tx) => {
        const sql = (async (query: TemplateStringsArray | string, ...values: unknown[]) => {
          const { text, values: params } = toQuery(query, values, (index) => `$${index}`);
          return tx.unsafe(text, params);
        }) as MigrationContext["sql"];
        await module[direction]({ sql, db, repos } satisfies MigrationContext);
        if (direction === "up") {
          await tx.unsafe(`insert into ${HISTORY_TABLE} (id, name, applied_at) values ($1, $2, now())`, [migration.id, migration.name]);
        } else {
          await tx.unsafe(`delete from ${HISTORY_TABLE} where id = $1`, [migration.id]);
        }
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
  if (adapter.kind === "postgres") return postgresDriver(adapter.client as SQL);
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
        throw new BuildError(`Migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      (direction === "up" ? result.applied : result.reverted).push(migration.id);
      result.messages.push(`${direction === "up" ? "Applied" : "Reverted"} ${migration.id}`);
    }
    if (steps.length === 0) result.messages.push("Database is up to date (0 migrations applied)");
    return result;
  });
}
