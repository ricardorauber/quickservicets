import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import {
  createRepositories,
  loadConfig,
  type MigrationContext,
  type Repositories,
  type ResolvedConfig,
} from "@quickservice/core";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzlePostgres } from "drizzle-orm/bun-sql";
import { parseEntities } from "../entities/parse-entities.ts";
import { BuildError } from "../errors.ts";
import { listMigrations, type MigrationFile } from "./snapshot.ts";

export const HISTORY_TABLE = "__quickservice_migrations";

export interface MigrateOptions {
  target?: string;
  force?: boolean;
}

export interface MigrateResult {
  applied: string[];
  reverted: string[];
  messages: string[];
}

interface AppliedMigration {
  id: string;
  name: string;
}

/** Runs SQL and history changes for one dialect, one migration per transaction. */
interface MigrationDriver {
  ensureHistory(): Promise<void>;
  /** Applied migrations, or an empty list when the history table does not exist yet. */
  readHistory(): Promise<AppliedMigration[]>;
  applied(): Promise<AppliedMigration[]>;
  inTransaction(work: (sql: MigrationContext["sql"]) => Promise<void>): Promise<void>;
  record(sql: MigrationContext["sql"], migration: MigrationFile, applied: boolean): Promise<void>;
  db: unknown;
}

function toQuery(query: TemplateStringsArray | string, values: unknown[], placeholder: (index: number) => string) {
  if (typeof query === "string") return { text: query, values };
  return { text: query.reduce((text, part, index) => text + (index > 0 ? placeholder(index) : "") + part, ""), values };
}

function sqliteDriver(client: Database): MigrationDriver {
  const sql = (async (query: TemplateStringsArray | string, ...values: unknown[]) => {
    const { text, values: params } = toQuery(query, values, () => "?");
    return client.run(text, params as never[]);
  }) as MigrationContext["sql"];
  return {
    db: drizzleSqlite(client),
    async ensureHistory() {
      client.run(`create table if not exists ${HISTORY_TABLE} (id text primary key, name text not null, applied_at integer not null)`);
    },
    async applied() {
      return client.query(`select id, name from ${HISTORY_TABLE} order by id`).all() as AppliedMigration[];
    },
    async readHistory() {
      const exists = client.query("select name from sqlite_master where type = 'table' and name = ?").get(HISTORY_TABLE);
      return exists ? (client.query(`select id, name from ${HISTORY_TABLE} order by id`).all() as AppliedMigration[]) : [];
    },
    async inTransaction(work) {
      client.run("begin");
      try {
        await work(sql);
        client.run("commit");
      } catch (error) {
        client.run("rollback");
        throw error;
      }
    },
    async record(run, migration, applied) {
      if (applied) await run(`insert into ${HISTORY_TABLE} (id, name, applied_at) values (?, ?, ?)`, migration.id, migration.name, Date.now());
      else await run(`delete from ${HISTORY_TABLE} where id = ?`, migration.id);
    },
  };
}

function postgresDriver(client: SQL): MigrationDriver {
  return {
    db: drizzlePostgres({ client }),
    async ensureHistory() {
      await client.unsafe(
        `create table if not exists ${HISTORY_TABLE} (id text primary key, name text not null, applied_at timestamptz not null)`,
      );
    },
    async applied() {
      return (await client.unsafe(`select id, name from ${HISTORY_TABLE} order by id`)) as AppliedMigration[];
    },
    async readHistory() {
      const [row] = (await client.unsafe("select to_regclass($1) as found", [HISTORY_TABLE])) as { found: string | null }[];
      return row?.found ? ((await client.unsafe(`select id, name from ${HISTORY_TABLE} order by id`)) as AppliedMigration[]) : [];
    },
    async inTransaction(work) {
      await client.begin(async (tx) => {
        const sql = (async (query: TemplateStringsArray | string, ...values: unknown[]) => {
          const { text, values: params } = toQuery(query, values, (index) => `$${index}`);
          return tx.unsafe(text, params);
        }) as MigrationContext["sql"];
        await work(sql);
      });
    },
    async record(run, migration, applied) {
      if (applied) await run(`insert into ${HISTORY_TABLE} (id, name, applied_at) values ($1, $2, now())`, migration.id, migration.name);
      else await run(`delete from ${HISTORY_TABLE} where id = $1`, migration.id);
    },
  };
}

function driverFor(config: ResolvedConfig): MigrationDriver {
  const adapter = config.database as { kind?: string; client?: unknown };
  if (adapter.kind === "sqlite") return sqliteDriver(adapter.client as Database);
  if (adapter.kind === "postgres") return postgresDriver(adapter.client as SQL);
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
  direction: "up" | "down";
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

/** `quickservice migrate [target] [--force]` */
export async function migrate(projectRoot: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  const config = await loadConfig(projectRoot);
  if (config.database.kind === "memory") {
    return { applied: [], reverted: [], messages: ["Nothing to migrate: the memory adapter keeps no schema"] };
  }
  const models = parseEntities(projectRoot);
  await config.database.connect(models);
  try {
    const driver = driverFor(config);
    await driver.ensureHistory();
    const files = listMigrations(projectRoot);
    const applied = await driver.applied();
    const missing = applied.filter((migration) => !files.some((file) => file.id === migration.id));
    if (missing.length > 0) {
      throw new BuildError(`Applied migrations are missing on disk: ${missing.map((migration) => migration.id).join(", ")}`);
    }
    const steps = planSteps(files, applied, options.target);
    const downs = steps.filter((step) => step.direction === "down");
    if (config.production && downs.length > 0 && !options.force) {
      throw new BuildError(
        `Reverting migrations in production requires --force (would revert: ${downs.map((step) => step.migration.id).join(", ")})`,
      );
    }

    const repos = createRepositories(models, config.database) as unknown as Repositories;
    const result: MigrateResult = { applied: [], reverted: [], messages: [] };
    for (const { migration, direction } of steps) {
      const module = (await import(migration.file)) as Record<"up" | "down", (ctx: MigrationContext) => Promise<void>>;
      try {
        await driver.inTransaction(async (sql) => {
          await module[direction]({ sql, db: driver.db, repos });
          await driver.record(sql, migration, direction === "up");
        });
      } catch (error) {
        throw new BuildError(`Migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (direction === "up") {
        result.applied.push(migration.id);
        result.messages.push(`Applied ${migration.id}`);
      } else {
        result.reverted.push(migration.id);
        result.messages.push(`Reverted ${migration.id}`);
      }
    }
    if (steps.length === 0) result.messages.push("Database is up to date (0 migrations applied)");
    return result;
  } finally {
    await config.database.disconnect();
  }
}

/** Reads the applied migrations of the configured SQL database without changing it. */
export async function readAppliedMigrations(projectRoot: string): Promise<AppliedMigration[]> {
  const config = await loadConfig(projectRoot);
  if (config.database.kind === "memory") throw new BuildError("Migrations are not used with the memory adapter");
  const driverConfig = config;
  await config.database.connect(parseEntities(projectRoot));
  try {
    return await driverFor(driverConfig).readHistory();
  } finally {
    await config.database.disconnect();
  }
}

export type { AppliedMigration };
