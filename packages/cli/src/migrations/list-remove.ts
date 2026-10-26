import { readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { BuildError } from "../errors.ts";
import { readAppliedMigrations, readMigrationHistory, type MigrationHistory } from "./migrate.ts";
import { listMigrations, snapshotFile, type MigrationFile } from "./snapshot.ts";

export type MigrationStatus = "applied" | "pending" | "missing" | "unknown";

export interface MigrationListEntry {
  id: string;
  status: MigrationStatus;
  /** For migrations with statements marked with an explicit schema: how many default schemas applied it there. */
  schemas?: { schema: string; tenants: number }[];
}

export interface MigrationList {
  entries: MigrationListEntry[];
  warning?: string;
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

/** `quickservicets migration list` */
export async function listMigrationStatus(projectRoot: string): Promise<MigrationList> {
  const files = listMigrations(projectRoot);
  const marked = new Map(files.map((file) => [file.id, markedSchemas(file)]));
  let history: MigrationHistory;
  try {
    history = await readMigrationHistory(projectRoot, [...new Set([...marked.values()].flat())]);
  } catch (error) {
    if (error instanceof BuildError) throw error;
    return {
      entries: files.map((file) => ({ id: file.id, status: "unknown" })),
      warning: `Could not reach the database: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { applied } = history;
  const appliedIds = new Set(applied.map((migration) => migration.id));
  const entries: MigrationListEntry[] = files.map((file) => {
    const entry: MigrationListEntry = { id: file.id, status: appliedIds.has(file.id) ? "applied" : "pending" };
    const schemas = marked.get(file.id) ?? [];
    if (schemas.length > 0) {
      entry.schemas = schemas.map((schema) => ({ schema, tenants: history.schemas.get(schema)?.get(file.id)?.length ?? 0 }));
    }
    return entry;
  });
  for (const migration of applied) {
    if (!files.some((file) => file.id === migration.id)) entries.push({ id: migration.id, status: "missing" });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries };
}

/** `quickservicets migration remove`: deletes the newest migration when it has not been applied. */
export async function removeLatestMigration(projectRoot: string): Promise<string[]> {
  const files = listMigrations(projectRoot);
  const latest = files.at(-1);
  if (!latest) throw new BuildError("No migrations to remove");
  const applied = await readAppliedMigrations(projectRoot);
  if (applied.some((migration) => migration.id === latest.id)) {
    const previous = files.at(-2)?.name ?? "0";
    throw new BuildError(`Migration ${latest.id} is applied. Revert it with "quickservicets migrate ${previous}" first`);
  }
  const removed = [latest.file, snapshotFile(projectRoot, latest.id)];
  for (const file of removed) rmSync(file, { force: true });
  return removed.map((file) => relative(projectRoot, file));
}
