import { HttpError } from "../errors.ts";
import type { ServiceRequest } from "../hooks.ts";
import type { EntityModel } from "../model.ts";
import { repositoryFor, type RepositoryRegistry } from "../repository.ts";
import { fileTargetOf, type FileReference } from "./field-limits.ts";
import { assertFileAllowed, formFields, readMultipart, storeFile, type UploadSettings } from "./upload.ts";

const invalid = (field: string, message: string) => new HttpError(400, "Invalid body", { details: [{ field, message }] });

export function isMultipart(req: ServiceRequest): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

export interface EntityUpload {
  /** The record's fields, with uploaded file parts not yet stored. */
  data: Record<string, unknown>;
  files: { field: FileReference; target: EntityModel; file: Blob & { name?: string } }[];
}

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
    if (values.length > 1 || name in data) throw invalid(name, "Duplicate field");
    const file = values[0] as Blob & { name?: string };
    assertFileAllowed(target, file, settings, name, field!.fileLimits);
    files.push({ field: field as FileReference, target, file });
  }
  return { data, files };
}

/**
 * Stores the uploaded files as records of their file entities, sets the fields to their ids and runs `write`;
 * when anything fails, the file records and objects created so far are removed.
 */
export async function withUploadedFiles<T>(
  upload: EntityUpload,
  repos: RepositoryRegistry,
  settings: UploadSettings,
  write: (data: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const created: (() => Promise<void>)[] = [];
  const data = { ...upload.data };
  try {
    for (const { field, target, file } of upload.files) {
      const id = Bun.randomUUIDv7();
      const stored = await storeFile(target, id, file, settings);
      created.push(stored.discard);
      const repository = repositoryFor(repos, target);
      await repository.createWith(id, stored.managed, {});
      created.push(() => repository.delete(id));
      data[field.name] = id;
    }
    return await write(data);
  } catch (error) {
    for (const undo of created.reverse()) await undo().catch(() => {});
    throw error;
  }
}
