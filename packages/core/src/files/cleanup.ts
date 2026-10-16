import type { DatabaseAdapter } from "../adapter.ts";
import { safeLog, type Logger } from "../logger.ts";
import type { EntityModel } from "../model.ts";
import type { StorageAdapter } from "../storage/storage.ts";
import { fileTargetOf, type FileReference } from "./field-limits.ts";

export interface FileCleanupSettings {
  storage: Record<string, StorageAdapter>;
  /** Delete a file record's object when the record is deleted. */
  deleteOnRemove: boolean;
  /** Delete replaced content, and files no longer referenced after a reference changes. */
  deleteReplaced: boolean;
  /** Delete the files a record references when the record is deleted. */
  deleteWithOwner: boolean;
  logger?: Logger;
}

/** A stored object waiting to be deleted once the database changes are committed. */
export interface StoredObject {
  storage: string;
  key: string;
}

/** References to file entities whose files are removed with the record or when replaced (not `@keepFile`). */
export function ownedFileFields(model: EntityModel, models: EntityModel[]): { field: FileReference; target: EntityModel }[] {
  return model.fields.flatMap((field) => {
    const target = field.storage === "derived" || field.keepFile ? undefined : fileTargetOf(field, models);
    return target ? [{ field: field as FileReference, target }] : [];
  });
}

/** The file ids a reference or reference array value holds. */
export function referencedIds(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
}

/** Whether any record of any entity still references the file. */
export async function isFileReferenced(target: EntityModel, id: string, models: EntityModel[], adapter: DatabaseAdapter): Promise<boolean> {
  for (const model of models) {
    for (const field of model.fields) {
      if ((field.type !== "ref" && field.type !== "refArray") || field.target !== target.key || field.storage === "derived") continue;
      const op = field.type === "ref" ? "eq" : "contains";
      if ((await adapter.count(model, [{ field: field.name, op, value: id }])) > 0) return true;
    }
  }
  return false;
}

/** The object of a stored file record. */
export function objectOf(model: EntityModel, record: Record<string, unknown>): StoredObject | undefined {
  if (typeof record.storageKey !== "string") return undefined;
  return { storage: (record.storage as string | undefined) ?? model.storageName ?? "default", key: record.storageKey };
}

/** Deletes objects, logging failures at `warn` without failing. */
export async function deleteObjects(objects: StoredObject[], settings: FileCleanupSettings): Promise<void> {
  for (const object of objects) {
    try {
      const storage = settings.storage[object.storage];
      if (!storage) throw new Error(`Storage "${object.storage}" is not configured`);
      await storage.delete(object.key);
    } catch (error) {
      if (!settings.logger) continue;
      safeLog(settings.logger, "warn", {
        timestamp: new Date().toISOString(),
        message: "File object not deleted",
        storage: object.storage,
        key: object.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
