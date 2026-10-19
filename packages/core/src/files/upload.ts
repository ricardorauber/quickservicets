import { HttpError } from "../errors.ts";
import type { ServiceRequest } from "../hooks.ts";
import { MEDIA_MIME_TYPES } from "../files.ts";
import type { EntityModel, FieldModel } from "../model.ts";
import { storageKeyFor, type StorageAdapter } from "../storage/storage.ts";
import { declaredTypeFits, detectFileType } from "./detect.ts";
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

const CRLF = Buffer.from("\r\n");
const HEADERS_END = Buffer.from("\r\n\r\n");

/**
 * The `Content-Type` header of each file part (a part with a file name), by part name and in part order;
 * undefined where the part has none. Read from the raw body because the form parser derives types from file names.
 */
function declaredFileTypes(body: Buffer, contentType: string): Map<string, (string | undefined)[]> {
  const types = new Map<string, (string | undefined)[]>();
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundary) return types;
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let position = body.indexOf(delimiter);
  while (position !== -1) {
    position += delimiter.length;
    if (body.subarray(position, position + 2).toString() === "--") break;
    const headersStart = body.indexOf(CRLF, position) + CRLF.length;
    const headersEnd = body.indexOf(HEADERS_END, headersStart);
    if (headersStart < CRLF.length || headersEnd === -1) break;
    let name: string | undefined;
    let isFile = false;
    let type: string | undefined;
    for (const line of body.subarray(headersStart, headersEnd).toString("utf8").split("\r\n")) {
      const separator = line.indexOf(":");
      const header = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (header === "content-type") type = value;
      if (header === "content-disposition") {
        name = /(?:^|;)\s*name="([^"]*)"/i.exec(value)?.[1] ?? /(?:^|;)\s*name=([^;\s]+)/i.exec(value)?.[1];
        isFile = /(?:^|;)\s*filename\*?=/i.test(value);
      }
    }
    if (name !== undefined && isFile) types.set(name, [...(types.get(name) ?? []), type]);
    position = body.indexOf(Buffer.concat([CRLF, delimiter]), headersEnd);
    if (position !== -1) position += CRLF.length;
  }
  return types;
}

/** Parses a multipart body; each file part carries the type its `Content-Type` header declared (empty when it has none). */
export async function readMultipart(req: ServiceRequest): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Must be multipart/form-data");
  }
  const body = Buffer.from(await req.raw.arrayBuffer());
  const parsed = (await new Response(body, { headers: { "content-type": type } }).formData()) as unknown as FormData;
  const declared = declaredFileTypes(body, type);
  const seen = new Map<string, number>();
  const form = new FormData();
  for (const [name, value] of parsed.entries()) {
    if (typeof value === "string") {
      form.append(name, value);
      continue;
    }
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    const file = value as File;
    form.append(name, new File([file], file.name, { type: declared.get(name)?.[index] ?? "" }));
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
  const detected = await detectFileType(file);
  const declared = essence(file.type);
  const name = file.name ?? "file";
  const keep = () => (file instanceof File ? file : new File([file], name, { type: file.type }));
  if (detected === undefined) return keep();
  if (declared === "" || declared === "application/octet-stream" || declared === detected) return new File([file], name, { type: detected });
  if (declaredTypeFits(detected, declared)) return keep();
  throw new HttpError(415, "File content does not match its type", {
    details: [{ field: path, message: `Detected ${detected}, declared ${declared}` }],
  });
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
  const resolved = await resolveUploadType(file, "file");
  assertFileAllowed(model, resolved, settings, "file");
  return { file: resolved, data: formFields(model, form, (name) => name === "file") };
}
