import { randomUUIDv7 } from "bun";
import type { EntityModel } from "../model.ts";

export type StorageBody = ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array | string;

/** Where file bytes live. Keys are relative paths such as `media/<id>/<objectId>.png`. */
export interface StorageAdapter {
  put(key: string, body: StorageBody, options: { contentType: string; size: number }): Promise<void>;
  /** The object's bytes, or null when the key does not exist. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Removes the object; removing a missing key succeeds. */
  delete(key: string): Promise<void>;
  publicUrl?(key: string): string;
  signedUrl?(key: string, ttlSeconds: number): string | Promise<string>;
}

export class StorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${key}`);
    this.name = "StorageKeyError";
  }
}

/** Rejects absolute keys and keys with `..` segments, so objects never escape the storage root. */
export function assertSafeKey(key: string): void {
  if (key === "" || key.startsWith("/") || key.startsWith("\\\\") || /^[a-zA-Z]:/.test(key)) throw new StorageKeyError(key);
  if (key.split(/[\\\\/]/).some((segment) => segment === ".." || segment === ".")) throw new StorageKeyError(key);
}

/** Lowercase extension of a file name (`.png`), or empty. */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** `<schema>/<collection>/<id>/<objectId><ext>`, with a new object id every time. */
export function storageKeyFor(model: Pick<EntityModel, "schema" | "name">, id: string, filename: string): string {
  const prefix = model.schema ? `${model.schema}/` : "";
  return `${prefix}${model.name}/${id}/${randomUUIDv7()}${extensionOf(filename)}`;
}
