import { buildDrizzleSchema, type EntityModel, type SqlDialect } from "@quickservice/core";
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

export interface ModelSnapshot {
  dialect: SqlDialect;
  models: EntityModel[];
  drizzle: DrizzleSnapshot;
}

export interface MigrationFile {
  /** `<YYYYMMDDHHmmss>_<Name>` */
  id: string;
  name: string;
  file: string;
}

export async function drizzleSnapshot(models: EntityModel[], dialect: SqlDialect): Promise<DrizzleSnapshot> {
  const { tables } = buildDrizzleSchema(models, dialect);
  return (dialect === "sqlite" ? await generateSQLiteDrizzleJson(tables) : generateDrizzleJson(tables)) as unknown as DrizzleSnapshot;
}

export function listMigrations(projectRoot: string): MigrationFile[] {
  const dir = join(projectRoot, MIGRATIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => /^\d{14}_[A-Z][A-Za-z0-9]*\.ts$/.test(entry))
    .sort()
    .map((entry) => {
      const id = entry.slice(0, -3);
      return { id, name: id.slice(15), file: join(dir, entry) };
    });
}

const snapshotPath = (projectRoot: string, id: string) => join(projectRoot, MIGRATIONS_DIR, "meta", `${id}.snapshot.json`);

export function readLatestSnapshot(projectRoot: string): ModelSnapshot | undefined {
  const latest = listMigrations(projectRoot).at(-1);
  if (!latest || !existsSync(snapshotPath(projectRoot, latest.id))) return undefined;
  return JSON.parse(readFileSync(snapshotPath(projectRoot, latest.id), "utf8")) as ModelSnapshot;
}

export function writeSnapshot(projectRoot: string, id: string, snapshot: ModelSnapshot): string {
  mkdirSync(join(projectRoot, MIGRATIONS_DIR, "meta"), { recursive: true });
  const path = snapshotPath(projectRoot, id);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return path;
}

export function snapshotFile(projectRoot: string, id: string): string {
  return snapshotPath(projectRoot, id);
}
