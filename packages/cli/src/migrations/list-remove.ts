import { readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { BuildError } from "../errors.ts";
import { databaseAdapters, loadConfig } from "@quickservicets/core";
import { readDatabaseHistories, type DatabaseMigrationHistory } from "./migrate.ts";
import { listMigrations, snapshotFile, type MigrationFile } from "./snapshot.ts";

export type MigrationStatus = "applied" | "pending" | "missing" | "unknown";

export interface MigrationListEntry {
  id: string;
  status: MigrationStatus;
  /** The database the migration belongs to: `default`, or a name of `databases`. */
  database: string;
  /** For migrations with statements marked with an explicit schema: how many default schemas applied it there. */
  schemas?: { schema: string; tenants: number }[];
}

export interface MigrationList {
  entries: MigrationListEntry[];
  warning?: string;
  /** Whether the project has named databases, so the listing groups by database. */
  named?: boolean;
}

const SCHEMA_OPTION = /\{\s*schema:\s*(["'])([^"']+)\1\s*\}/g;

/** The explicit schemas a migration file marks its statements with, in order of first use. */
function markedSchemas(file: MigrationFile): string[] {
  return [...new Set([...readFileSync(file.file, "utf8").matchAll(SCHEMA_OPTION)].map((match) => match[2]!))];
}

/** `billing: 2 tenants, auth: 1 tenant` */
export function formatSchemaCounts(schemas: { schema: string; tenants: number }[]): string {
  return schemas.map(({ schema, tenants }) => `${schema}: ${tenants} ${tenants === 1 ? "tenant" : "tenants"}`).join(", ");
}

/** The databases that keep migrations (not memory ones), default first, and whether the project has named ones. */
async function migratedDatabases(projectRoot: string): Promise<{ databases: string[]; named: boolean }> {
  const config = await loadConfig(projectRoot);
  const all = databaseAdapters(config.database);
  return { databases: all.filter(([, adapter]) => adapter.kind !== "memory").map(([name]) => name), named: all.length > 1 };
}

/** `quickservicets migration list`: the migrations of every database with their status, grouped by database. */
export async function listMigrationStatus(projectRoot: string): Promise<MigrationList> {
  const { databases, named } = await migratedDatabases(projectRoot);
  if (databases.length === 0) throw new BuildError("Migrations are not used with the memory adapter");
  const files = new Map(databases.map((database) => [database, listMigrations(projectRoot, database)]));
  const marked = new Map([...files.values()].flat().map((file) => [file.file, markedSchemas(file)]));
  let histories: DatabaseMigrationHistory[];
  try {
    histories = await readDatabaseHistories(projectRoot, (database) => [...new Set((files.get(database) ?? []).flatMap((file) => marked.get(file.file) ?? []))]);
  } catch (error) {
    if (error instanceof BuildError) throw error;
    return {
      entries: databases.flatMap((database) => files.get(database)!.map((file) => ({ id: file.id, status: "unknown" as const, database }))),
      warning: `Could not reach the database: ${error instanceof Error ? error.message : String(error)}`,
      named,
    };
  }
  const entries: MigrationListEntry[] = [];
  for (const history of histories) {
    const own: MigrationListEntry[] = [];
    const appliedIds = new Set(history.applied.map((migration) => migration.id));
    for (const file of history.files) {
      const entry: MigrationListEntry = { id: file.id, status: appliedIds.has(file.id) ? "applied" : "pending", database: history.database };
      const schemas = marked.get(file.file) ?? [];
      if (schemas.length > 0) {
        entry.schemas = schemas.map((schema) => ({ schema, tenants: history.schemas.get(schema)?.get(file.id)?.length ?? 0 }));
      }
      own.push(entry);
    }
    for (const migration of history.applied) {
      if (!history.files.some((file) => file.id === migration.id)) own.push({ id: migration.id, status: "missing", database: history.database });
    }
    own.sort((a, b) => a.id.localeCompare(b.id));
    entries.push(...own);
  }
  return { entries, named };
}

/** `quickservicets migration remove`: deletes the newest migration (in every database that has it) when it has not been applied. */
export async function removeLatestMigration(projectRoot: string): Promise<string[]> {
  const { databases } = await migratedDatabases(projectRoot);
  const files = new Map(databases.map((database) => [database, listMigrations(projectRoot, database)]));
  const latestId = [...files.values()].flatMap((list) => list.map((file) => file.id)).sort().at(-1);
  if (!latestId) throw new BuildError("No migrations to remove");
  const histories = await readDatabaseHistories(projectRoot, () => []);
  const removed: string[] = [];
  for (const database of databases) {
    const list = files.get(database)!;
    const latest = list.find((file) => file.id === latestId);
    if (!latest) continue;
    if (histories.find((history) => history.database === database)?.applied.some((migration) => migration.id === latest.id)) {
      const previous = list.at(-2)?.name ?? "0";
      throw new BuildError(`Migration ${latest.id} is applied. Revert it with "quickservicets migrate ${previous}" first`);
    }
    removed.push(latest.file, snapshotFile(projectRoot, latest.id, database));
  }
  for (const file of removed) rmSync(file, { force: true });
  return removed.map((file) => relative(projectRoot, file));
}
