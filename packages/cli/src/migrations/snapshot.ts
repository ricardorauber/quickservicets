import { buildDrizzleSchema, DEFAULT_DATABASE, SQLITE_DEFAULT_SCHEMA_TOKEN, type EntityModel, type MongoIndexSpec, type SqlDialect } from "@quickservicets/core";
import { generateDrizzleJson, generateSQLiteDrizzleJson } from "drizzle-kit/api";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = "migrations";

/** Drizzle-kit's JSON description of a schema; its shape depends on the dialect. */
export type DrizzleSnapshot = Record<string, unknown> & { tables: Record<string, TableSnapshot> };

export interface TableSnapshot {
  name: string;
  columns: Record<string, unknown>;
  indexes: Record<string, { columns: unknown[] }>;
  foreignKeys: Record<string, { columnsFrom: string[]; tableTo: string }>;
  checkConstraints?: Record<string, { value: string }>;
  [key: string]: unknown;
}

export interface SqlModelSnapshot {
  dialect: SqlDialect;
  models: EntityModel[];
  drizzle: DrizzleSnapshot;
}

export interface MongoModelSnapshot {
  dialect: "mongodb";
  models: EntityModel[];
  indexes: MongoIndexSpec[];
}

export type ModelSnapshot = SqlModelSnapshot | MongoModelSnapshot;

export interface MigrationFile {
  /** `<YYYYMMDDHHmmss>_<Name>` */
  id: string;
  name: string;
  file: string;
}

export async function drizzleSnapshot(models: EntityModel[], dialect: SqlDialect): Promise<DrizzleSnapshot> {
  // Default-schema SQLite tables carry a placeholder prefix that is resolved when migrations run.
  const { tables, schemas, junctions } = buildDrizzleSchema(models, dialect, { sqliteDefaultPrefix: SQLITE_DEFAULT_SCHEMA_TOKEN });
  const allTables = { ...tables, ...junctions };
  const definitions = { ...allTables, ...Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [`schema:${name}`, schema])) };
  return (dialect === "sqlite" ? await generateSQLiteDrizzleJson(allTables) : generateDrizzleJson(definitions)) as unknown as DrizzleSnapshot;
}

/**
 * The migrations folder of a database: `migrations/` for the default one, `migrations/<name>/` for a named one, each
 * with its own `meta/` snapshots.
 */
export function migrationsFolder(projectRoot: string, database: string = DEFAULT_DATABASE): string {
  return database === DEFAULT_DATABASE ? join(projectRoot, MIGRATIONS_DIR) : join(projectRoot, MIGRATIONS_DIR, database);
}

export function listMigrations(projectRoot: string, database: string = DEFAULT_DATABASE): MigrationFile[] {
  const dir = migrationsFolder(projectRoot, database);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => /^\d{14}_[A-Z][A-Za-z0-9]*\.ts$/.test(entry))
    .sort()
    .map((entry) => {
      const id = entry.slice(0, -3);
      return { id, name: id.slice(15), file: join(dir, entry) };
    });
}

const snapshotPath = (projectRoot: string, id: string, database?: string) => join(migrationsFolder(projectRoot, database), "meta", `${id}.snapshot.json`);

export function readLatestSnapshot(projectRoot: string, database?: string): ModelSnapshot | undefined {
  const latest = listMigrations(projectRoot, database).at(-1);
  if (!latest || !existsSync(snapshotPath(projectRoot, latest.id, database))) return undefined;
  return JSON.parse(readFileSync(snapshotPath(projectRoot, latest.id, database), "utf8")) as ModelSnapshot;
}

export function writeSnapshot(projectRoot: string, id: string, snapshot: ModelSnapshot, database?: string): string {
  mkdirSync(join(migrationsFolder(projectRoot, database), "meta"), { recursive: true });
  const path = snapshotPath(projectRoot, id, database);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return path;
}

export function snapshotFile(projectRoot: string, id: string, database?: string): string {
  return snapshotPath(projectRoot, id, database);
}
