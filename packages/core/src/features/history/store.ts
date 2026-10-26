import { UniqueViolationError, type DatabaseAdapter, type EntityModel, type StoredRecord } from "../public.ts";
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
