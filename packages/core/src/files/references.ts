import { HttpError } from "../errors.ts";
import type { ServiceRequest } from "../hooks.ts";
import type { EntityModel } from "../model.ts";
import { repositoryFor, type RepositoryRegistry } from "../repository.ts";
import { fileTargetOf, type FileReference } from "./field-limits.ts";
import { assertFileAllowed, formFields, readMultipart, resolveUploadType, storeFile, type UploadSettings } from "./upload.ts";

const invalid = (field: string, message: string) => new HttpError(400, "Invalid body", { details: [{ field, message }] });

export function isMultipart(req: ServiceRequest): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

export interface EntityUpload {
  /** The record's fields, with uploaded file parts not yet stored. */
  data: Record<string, unknown>;
  /** File parts per reference field, in part order. */
  files: { field: FileReference; target: EntityModel; files: (Blob & { name?: string })[] }[];
}

/** How uploaded ids combine with a field's value: `create`/`replace` set the list, `patch` adds to it. */
export type UploadMode = "create" | "replace" | "patch";

/** Reads a multipart body of a regular entity: fields as form values or a `data` part, and file parts per reference field. */
export async function parseEntityUpload(
  req: ServiceRequest,
  model: EntityModel,
  models: EntityModel[],
  settings: UploadSettings,
): Promise<EntityUpload> {
  const form = await readMultipart(req);
  const fileNames = [...new Set([...form.keys()])].filter((name) => form.getAll(name).some((value) => value instanceof Blob));
  const data = formFields(model, form, (name) => fileNames.includes(name));
  const files: EntityUpload["files"] = [];
  for (const name of fileNames) {
    const field = model.fields.find((candidate) => candidate.name === name);
    const target = fileTargetOf(field, models);
    if (!target) throw invalid(name, "Unknown field");
    const values = form.getAll(name);
    let parts = values.filter((value): value is File => value instanceof Blob);
    const ids = values.filter((value): value is string => typeof value === "string");
    if (field!.type === "ref") {
      if (values.length > 1 || name in data) throw invalid(name, "Duplicate field");
      parts = [await resolveUploadType(parts[0]!, name)];
      assertFileAllowed(target, parts[0]!, settings, name, field!.fileLimits);
    } else {
      // An array takes its current value from form values or the data part, never both; the files come after it.
      if (ids.length > 0 && name in data) throw invalid(name, "Duplicate field");
      if (ids.length > 0) data[name] = ids;
      parts = await Promise.all(parts.map((part, index) => resolveUploadType(part, `${name}[${index}]`)));
      parts.forEach((part, index) => assertFileAllowed(target, part, settings, `${name}[${index}]`, field!.fileLimits));
      const maxTotalSize = field!.fileLimits?.maxTotalSize;
      if (maxTotalSize !== undefined && parts.reduce((total, part) => total + part.size, 0) > maxTotalSize) {
        throw new HttpError(413, "Total upload size too large", { details: [{ field: name, message: "Total upload size too large" }] });
      }
    }
    files.push({ field: field as FileReference, target, files: parts });
  }
  return { data, files };
}

/** The value of an array field with the uploaded ids at the end; values that are not lists are left for validation. */
function withUploadedIds(value: unknown, ids: string[], mode: UploadMode): unknown {
  if (value === undefined || value === null) return mode === "patch" ? { add: ids } : ids;
  if (Array.isArray(value)) return [...value, ...ids];
  if (mode === "patch" && typeof value === "object") {
    const change = value as { add?: unknown };
    return { ...change, add: Array.isArray(change.add) ? [...change.add, ...ids] : change.add === undefined ? ids : change.add };
  }
  return value;
}

/**
 * Stores the uploaded files as records of their file entities, sets the fields to their ids and runs `write`;
 * when anything fails, the file records and objects created so far are removed.
 */
export async function withUploadedFiles<T>(
  upload: EntityUpload,
  repos: RepositoryRegistry,
  settings: UploadSettings,
  mode: UploadMode,
  write: (data: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const created: (() => Promise<void>)[] = [];
  const data = { ...upload.data };
  try {
    for (const { field, target, files } of upload.files) {
      const ids: string[] = [];
      for (const file of files) {
        const id = Bun.randomUUIDv7();
        const stored = await storeFile(target, id, file, settings);
        created.push(stored.discard);
        const repository = repositoryFor(repos, target);
        await repository.createWith(id, stored.managed, {});
        created.push(() => repository.delete(id));
        ids.push(id);
      }
      data[field.name] = field.type === "ref" ? ids[0] : withUploadedIds(data[field.name], ids, mode);
    }
    return await write(data);
  } catch (error) {
    for (const undo of created.reverse()) await undo().catch(() => {});
    throw error;
  }
}
