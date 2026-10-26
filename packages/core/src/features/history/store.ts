import { UniqueViolationError, type Condition, type DatabaseAdapter, type EntityModel, type StoredRecord } from "../public.ts";
import type { HistoryVersion } from "./model.ts";

/** A version as `write` takes it: everything but its number, which the store gives it. */
export type NewVersion = Omit<HistoryVersion, "version">;

/** The highest stored version of a record, 0 when it has none. */
async function latestVersion(adapter: DatabaseAdapter, model: EntityModel, entityId: string): Promise<number> {
  const { data } = await adapter.findMany(model, {
    where: [{ field: "entityId", op: "eq", value: entityId }],
    sort: [{ field: "version", direction: "desc" }],
    limit: 1,
    offset: 0,
    withTotal: false,
  });
  return Number(data[0]?.version ?? 0);
}

/**
 * Inserts a row, resolving false when another row already has its record and version. SQL databases skip the
 * conflicting row without failing the transaction; the others raise the unique violation.
 */
async function insertVersion(adapter: DatabaseAdapter, model: EntityModel, row: StoredRecord): Promise<boolean> {
  if ((adapter.kind === "postgres" || adapter.kind === "sqlite") && adapter.insertOrSkip) return (await adapter.insertOrSkip(model, row, "version")) !== null;
  try {
    await adapter.insert(model, row);
    return true;
  } catch (error) {
    if (error instanceof UniqueViolationError) return false;
    throw error;
  }
}

/**
 * Writes the next version of a record in the caller's transaction: one more than the highest stored version (1 when
 * none). A version number taken in the meantime is read again and tried once more; a second conflict fails the write.
 */
export async function writeVersion(adapter: DatabaseAdapter, model: EntityModel, version: NewVersion): Promise<HistoryVersion> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const written: HistoryVersion = { ...version, version: (await latestVersion(adapter, model, version.entityId)) + 1 };
    const row = {
      id: Bun.randomUUIDv7(),
      createdAt: version.at,
      updatedAt: version.at,
      ...written,
    } as unknown as StoredRecord;
    if (await insertVersion(adapter, model, row)) return written;
  }
  throw new Error(`Version conflict writing the history of ${version.entityId}`);
}

/** What the list of a record's versions takes: filters on `operation`, `at` and `actor`, and a page. */
export interface VersionQuery {
  where: Condition[];
  limit: number;
  offset: number;
}

/** A page of versions, newest first, with the number of matching versions. */
export interface VersionPage {
  data: HistoryVersion[];
  total: number;
}

const FIELDS = ["entityId", "version", "operation", "actor", "tenant", "requestId", "at", "record", "changed"] as const;

/** A stored row as a version: its fields only, without empty optional ones. */
export function versionOfRow(row: StoredRecord): HistoryVersion {
  const version: Record<string, unknown> = {};
  for (const name of FIELDS) {
    const value = row[name];
    if (value === null || value === undefined) continue;
    version[name] = name === "at" && !(value instanceof Date) ? new Date(value as string) : name === "version" ? Number(value) : value;
  }
  return version as unknown as HistoryVersion;
}

/** The versions of a record matching `query`, sorted by version descending. */
export async function listVersions(adapter: DatabaseAdapter, model: EntityModel, entityId: string, query: VersionQuery): Promise<VersionPage> {
  const { data, total } = await adapter.findMany(model, {
    where: [{ field: "entityId", op: "eq", value: entityId }, ...query.where],
    sort: [{ field: "version", direction: "desc" }],
    limit: query.limit,
    offset: query.offset,
  });
  return { data: data.map(versionOfRow), total };
}

/** One version of a record, or null when it does not exist. */
export async function getVersion(adapter: DatabaseAdapter, model: EntityModel, entityId: string, version: number): Promise<HistoryVersion | null> {
  const row = await adapter.findOne(model, [
    { field: "entityId", op: "eq", value: entityId },
    { field: "version", op: "eq", value: version },
  ]);
  return row ? versionOfRow(row) : null;
}
