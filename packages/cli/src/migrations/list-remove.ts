import { rmSync } from "node:fs";
import { relative } from "node:path";
import { BuildError } from "../errors.ts";
import { readAppliedMigrations, type AppliedMigration } from "./migrate.ts";
import { listMigrations, snapshotFile } from "./snapshot.ts";

export type MigrationStatus = "applied" | "pending" | "missing" | "unknown";

export interface MigrationListEntry {
  id: string;
  status: MigrationStatus;
}

export interface MigrationList {
  entries: MigrationListEntry[];
  warning?: string;
}

/** `quickservice migration list` */
export async function listMigrationStatus(projectRoot: string): Promise<MigrationList> {
  const files = listMigrations(projectRoot);
  let applied: AppliedMigration[];
  try {
    applied = await readAppliedMigrations(projectRoot);
  } catch (error) {
    if (error instanceof BuildError) throw error;
    return {
      entries: files.map((file) => ({ id: file.id, status: "unknown" })),
      warning: `Could not reach the database: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const appliedIds = new Set(applied.map((migration) => migration.id));
  const entries: MigrationListEntry[] = files.map((file) => ({ id: file.id, status: appliedIds.has(file.id) ? "applied" : "pending" }));
  for (const migration of applied) {
    if (!files.some((file) => file.id === migration.id)) entries.push({ id: migration.id, status: "missing" });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries };
}

/** `quickservice migration remove`: deletes the newest migration when it has not been applied. */
export async function removeLatestMigration(projectRoot: string): Promise<string[]> {
  const files = listMigrations(projectRoot);
  const latest = files.at(-1);
  if (!latest) throw new BuildError("No migrations to remove");
  const applied = await readAppliedMigrations(projectRoot);
  if (applied.some((migration) => migration.id === latest.id)) {
    const previous = files.at(-2)?.name ?? "0";
    throw new BuildError(`Migration ${latest.id} is applied. Revert it with "quickservice migrate ${previous}" first`);
  }
  const removed = [latest.file, snapshotFile(projectRoot, latest.id)];
  for (const file of removed) rmSync(file, { force: true });
  return removed.map((file) => relative(projectRoot, file));
}
