import { createHmac, timingSafeEqual } from "node:crypto";
import type { StoredRecord } from "../adapter.ts";
import { HttpError } from "../errors.ts";
import { entityRoutePath, type EntityModel, type FileAccessMode } from "../model.ts";
import type { StorageAdapter } from "../storage/storage.ts";

export interface FileAccessSettings {
  storage: Record<string, StorageAdapter>;
  files: { access?: FileAccessMode; signedUrlTtl: number; signingSecret?: string };
  /** Absolute base of proxy URLs, e.g. `https://api.example.com` (default: relative URLs). */
  publicUrl?: string;
  /** Current time in milliseconds (default `Date.now`). */
  now?: () => number;
  /** Headers added to (or replacing those of) every file response, from the stored file's type and name. */
  fileHeaders?: FileHeaders;
}

/** Computes headers for a served file from its stored type and name; `ctx.app.configureServer({ fileHeaders })` sets it. */
export type FileHeaders = (file: { mimeType: string; filename: string }) => Readonly<Record<string, string>>;

export interface FileAccess {
  mode: FileAccessMode;
  ttl: number;
}

function entityStorage(model: EntityModel, settings: Pick<FileAccessSettings, "storage">): StorageAdapter | undefined {
  return settings.storage[model.storageName ?? "default"];
}

/**
 * The entity's `@access` mode, else `files.access`; without either, `direct` when the storage serves public URLs
 * and `proxy` otherwise. The ttl is the tag's, else `files.signedUrlTtl`.
 */
export function resolveFileAccess(model: EntityModel, settings: Pick<FileAccessSettings, "storage" | "files">): FileAccess {
  const fallback: FileAccessMode = entityStorage(model, settings)?.publicUrl ? "direct" : "proxy";
  return {
    mode: model.fileAccess?.mode ?? settings.files.access ?? fallback,
    ttl: model.fileAccess?.ttl ?? settings.files.signedUrlTtl,
  };
}

/** Reasons the entity's access mode cannot work with its storage and config, or an empty list. */
export function fileAccessErrors(model: EntityModel, settings: Pick<FileAccessSettings, "storage" | "files">): string[] {
  const storageName = model.storageName ?? "default";
  const storage = settings.storage[storageName];
  if (!storage) return [];
  const { mode } = resolveFileAccess(model, settings);
  if (mode === "direct" && !storage.publicUrl) {
    return [`entity ${model.entityName} uses direct file access, but storage "${storageName}" has no publicUrl`];
  }
  if (mode === "signed" && !storage.signedUrl && !settings.files.signingSecret) {
    return [
      `entity ${model.entityName} uses signed file access, but storage "${storageName}" cannot sign URLs and files.signingSecret is not set`,
    ];
  }
  return [];
}

/** HMAC-SHA256 (hex) of the record id, object key and expiry. */
export function signFile(secret: string, id: string, storageKey: string, expires: number): string {
  return createHmac("sha256", secret).update(`${id}\n${storageKey}\n${expires}`).digest("hex");
}

/** Whether the signature matches and has not expired, comparing in constant time. */
export function verifyFileSignature(
  secret: string,
  id: string,
  storageKey: string,
  expires: string | null,
  signature: string | null,
  now: number,
): boolean {
  if (!expires || !signature || !/^\d+$/.test(expires)) return false;
  const expected = Buffer.from(signFile(secret, id, storageKey, Number(expires)));
  const given = Buffer.from(signature);
  const valid = given.length === expected.length && timingSafeEqual(given, expected);
  return valid && Number(expires) * 1000 >= now;
}

export function fileRoutePath(model: EntityModel, id: string, publicUrl = ""): string {
  return `${publicUrl.replace(/\/+$/, "")}${entityRoutePath(model)}/${id}/file`;
}

/** The `url` of a stored file record under the entity's access mode. */
export async function fileUrlOf(model: EntityModel, record: StoredRecord, settings: FileAccessSettings): Promise<string> {
  const storageKey = record.storageKey as string;
  const storage = settings.storage[(record.storage as string | undefined) ?? model.storageName ?? "default"] ?? entityStorage(model, settings);
  const { mode, ttl } = resolveFileAccess(model, settings);
  if (mode === "direct" && storage?.publicUrl) return storage.publicUrl(storageKey);
  const proxy = fileRoutePath(model, record.id, settings.publicUrl);
  if (mode !== "signed") return proxy;
  if (storage?.signedUrl) return storage.signedUrl(storageKey, ttl);
  const expires = Math.floor((settings.now ?? Date.now)() / 1000) + ttl;
  const signature = signFile(settings.files.signingSecret ?? "", record.id, storageKey, expires);
  return `${proxy}?expires=${expires}&signature=${signature}`;
}

/** Adds `url` to stored records of a file entity; other records are returned as they are. */
export async function withFileUrls(model: EntityModel, records: StoredRecord[], settings: FileAccessSettings | undefined) {
  if (!model.file || !settings) return records;
  return Promise.all(
    records.map(async (record) =>
      typeof record.storageKey === "string" ? { ...record, url: await fileUrlOf(model, record, settings) } : record,
    ),
  );
}

/**
 * `inline; filename="..."` (or `attachment; ...`), with quotes, backslashes and control characters removed from the
 * name.
 */
export function contentDisposition(filename: string, disposition: "inline" | "attachment" = "inline"): string {
  return `${disposition}; filename="${filename.replace(/["\\\r\n\x00-\x1f]/g, "")}"`;
}

/** Streams a file record's object with its content type, length and disposition. */
export async function fileResponse(model: EntityModel, record: StoredRecord, settings: FileAccessSettings): Promise<Response> {
  const storage = settings.storage[(record.storage as string | undefined) ?? model.storageName ?? "default"];
  const body = storage ? await storage.get(record.storageKey as string) : null;
  if (!body) throw new HttpError(404, `${model.entityName} file not found`);
  const headers = {
    "content-type": String(record.mimeType),
    "content-length": String(record.size),
    "content-disposition": contentDisposition(String(record.filename)),
  };
  return new Response(body, { headers: settings.fileHeaders ? { ...headers, ...settings.fileHeaders({ mimeType: String(record.mimeType), filename: String(record.filename) }) } : headers });
}
