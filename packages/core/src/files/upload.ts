import { HttpError } from "../errors.ts";
import type { ServiceRequest } from "../hooks.ts";
import { MEDIA_MIME_TYPES } from "../files.ts";
import type { EntityModel, FieldModel } from "../model.ts";
import { storageKeyFor, type StorageAdapter } from "../storage/storage.ts";
import { mimeMatches, sanitizeFilename } from "./limits.ts";

export interface UploadSettings {
  storage: Record<string, StorageAdapter>;
  files: { maxSize: number; accept: string[] };
}

export interface ParsedUpload {
  file: Blob & { name?: string };
  data: Record<string, unknown>;
}

const invalid = (field: string, message: string) => new HttpError(400, "Invalid body", { details: [{ field, message }] });

/** Converts a form value to the type of its field, leaving anything else for the body validator to report. */
export function coerceFormValue(field: FieldModel | undefined, values: string[]): unknown {
  if (field?.type === "refArray") return values;
  const [raw = ""] = values;
  switch (field?.type) {
    case "number":
      return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : raw;
    case "array":
    case "object":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

/** Reads entity fields sent as form fields or as one `data` part with JSON, rejecting a field sent both ways. */
export function formFields(model: EntityModel, form: FormData, skip: (name: string) => boolean): Record<string, unknown> {
  let data: Record<string, unknown> = {};
  const rawData = form.get("data");
  if (typeof rawData === "string") {
    try {
      data = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      throw invalid("data", "Must be a JSON object");
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw invalid("data", "Must be a JSON object");
  }
  const result: Record<string, unknown> = { ...data };
  const names = [...new Set([...form.keys()])].filter((name) => name !== "data" && !skip(name));
  for (const name of names) {
    if (name in data) throw invalid(name, "Duplicate field");
    const values = form.getAll(name).filter((value): value is string => typeof value === "string");
    result[name] = coerceFormValue(model.fields.find((field) => field.name === name), values);
  }
  return result;
}

export async function readMultipart(req: ServiceRequest): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Must be multipart/form-data");
  }
  return (await req.raw.formData()) as unknown as FormData;
}

/** Checks a file against the size and MIME limits of the entity (and of a field, when given). */
export function assertFileAllowed(
  model: EntityModel,
  file: { size: number; type: string },
  settings: UploadSettings,
  path: string,
  fieldLimits?: { maxSize?: number; accept?: string[] },
): void {
  const maxSize = Math.min(model.fileLimits?.maxSize ?? settings.files.maxSize, fieldLimits?.maxSize ?? Number.POSITIVE_INFINITY);
  if (file.size > maxSize) {
    throw new HttpError(413, "File too large", path === "file" ? undefined : { details: [{ field: path, message: "File too large" }] });
  }
  const allowed =
    mimeMatches(file.type, model.fileLimits?.accept ?? settings.files.accept) &&
    (model.file?.base !== "media" || mimeMatches(file.type, MEDIA_MIME_TYPES)) &&
    (fieldLimits?.accept === undefined || mimeMatches(file.type, fieldLimits.accept));
  if (!allowed) throw invalid(path, "File type not allowed");
}

export function storageOf(model: EntityModel, settings: UploadSettings): { name: string; storage: StorageAdapter } {
  const name = model.storageName ?? "default";
  const storage = settings.storage[name];
  if (!storage) throw new Error(`Storage "${name}" is not configured`);
  return { name, storage };
}

/** Stores the file and returns the fields the framework manages for it. */
export async function storeFile(model: EntityModel, id: string, file: Blob & { name?: string }, settings: UploadSettings) {
  const { name, storage } = storageOf(model, settings);
  const filename = sanitizeFilename(file.name ?? "file");
  const storageKey = storageKeyFor(model, id, filename);
  await storage.put(storageKey, file, { contentType: file.type, size: file.size });
  return {
    managed: { filename, mimeType: file.type, size: file.size, storage: name, storageKey },
    discard: () => storage.delete(storageKey),
  };
}

/** Parses an upload request to a file entity: the `file` part and the other fields. */
export async function parseUpload(req: ServiceRequest, model: EntityModel, settings: UploadSettings): Promise<ParsedUpload> {
  const form = await readMultipart(req);
  const file = form.get("file");
  if (!(file instanceof Blob)) throw invalid("file", "Is required");
  assertFileAllowed(model, file, settings, "file");
  return { file, data: formFields(model, form, (name) => name === "file") };
}
