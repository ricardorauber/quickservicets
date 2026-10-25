import { HttpError } from "../errors.ts";
import type { ServiceRequest } from "../hooks.ts";
import { MEDIA_MIME_TYPES } from "../files.ts";
import type { EntityModel, FieldModel } from "../model.ts";
import { storageKeyFor, type StorageAdapter } from "../storage/storage.ts";
import { declaredTypeFits, detectFileType, detectHeadType, HEAD_SIZE, isZipHead } from "./detect.ts";
import { mimeMatches, sanitizeFilename } from "./limits.ts";
import { boundaryOf, MultipartReader, type MultipartLimit } from "./multipart.ts";
import { readBodyBytes, readBodyChunks } from "../http/body.ts";

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

/** How far a body may exceed the largest file it can carry, for its other parts and headers, and still be read at once. */
const BUFFERED_ALLOWANCE = 64 * 1024;

/**
 * Parses a multipart body in one pass; each file part carries the type its `Content-Type` header declared (empty
 * when it has none). A body whose `Content-Length` is at most `maxFileSize` (by default the limit's size) plus a small
 * allowance is read at once; any other body is read as it arrives, so with a limit an oversized file part can fail
 * before the rest is read.
 */
export async function readMultipart(req: ServiceRequest, limit?: MultipartLimit, maxFileSize = limit?.maxSize ?? 0): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Must be multipart/form-data");
  }
  const boundary = boundaryOf(type);
  if (boundary === undefined) throw new TypeError("Can't decode form data from body because of incorrect MIME type/boundary");
  const declared = Number(req.headers.get("content-length")) || 0;
  const buffered = declared > 0 && declared <= maxFileSize + BUFFERED_ALLOWANCE;
  const reader = new MultipartReader(boundary, buffered ? 0 : declared, limit);
  // Both ways honor the request's body policy.
  if (buffered) reader.adopt(await readBodyBytes(req.raw));
  else await readBodyChunks(req.raw, (chunk) => reader.push(chunk));
  const { body, parts } = reader.end();
  const form = new FormData();
  for (const part of parts) {
    if (part.filename === undefined) form.append(part.name, body.toString("utf8", part.start, part.end));
    else form.append(part.name, new File([body.subarray(part.start, part.end)], part.filename, { type: part.type ?? "" }));
  }
  return form;
}

/** A MIME type without parameters, in lower case. */
const essence = (type: string) => type.split(";")[0]!.trim().toLowerCase();

/**
 * The file with the type its content shows: a recognized format replaces a missing or generic declared type and must
 * match any other one, unless that type may stand for the format; the declared type stays for formats the server
 * does not recognize.
 */
export async function resolveUploadType<T extends Blob & { name?: string }>(file: T, path: string): Promise<File> {
  const replaced = replacedType(await detectFileType(file), file.type, path);
  const name = file.name ?? "file";
  if (replaced !== undefined) return new File([file], name, { type: replaced });
  return file instanceof File ? file : new File([file], name, { type: file.type });
}

/** The detected type when it replaces the declared one, undefined when the declared type stays; fails on a mismatch. */
function replacedType(detected: string | undefined, type: string, path: string): string | undefined {
  const declared = essence(type);
  if (detected === undefined) return undefined;
  if (declared === "" || declared === "application/octet-stream" || declared === detected) return detected;
  if (declaredTypeFits(detected, declared)) return undefined;
  throw new HttpError(415, "File content does not match its type", {
    details: [{ field: path, message: `Detected ${detected}, declared ${declared}` }],
  });
}

/** The size limit of a file entity's files, and of a field's files when it has its own. */
export function maxFileSize(model: EntityModel, settings: UploadSettings, fieldLimits?: { maxSize?: number }): number {
  return Math.min(model.fileLimits?.maxSize ?? settings.files.maxSize, fieldLimits?.maxSize ?? Number.POSITIVE_INFINITY);
}

const tooLarge = (path: string) =>
  new HttpError(413, "File too large", path === "file" ? undefined : { details: [{ field: path, message: "File too large" }] });

/** Checks a file against the size and MIME limits of the entity (and of a field, when given). */
export function assertFileAllowed(
  model: EntityModel,
  file: { size: number; type: string },
  settings: UploadSettings,
  path: string,
  fieldLimits?: { maxSize?: number; accept?: string[] },
): void {
  if (file.size > maxFileSize(model, settings, fieldLimits)) throw tooLarge(path);
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
  // An oversized file whose type can be told from its first bytes fails as it would after reading the whole body.
  const form = await readMultipart(req, {
    name: "file",
    maxSize: maxFileSize(model, settings),
    headSize: HEAD_SIZE,
    check({ type, head }) {
      if (isZipHead(head)) return;
      replacedType(detectHeadType(head), type, "file");
      throw tooLarge("file");
    },
  });
  const file = form.get("file");
  if (!(file instanceof Blob)) throw invalid("file", "Is required");
  const resolved = await resolveUploadType(file, "file");
  assertFileAllowed(model, resolved, settings, "file");
  return { file: resolved, data: formFields(model, form, (name) => name === "file") };
}
