import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertSafeKey, type StorageAdapter } from "./storage.ts";

export interface LocalStorageOptions {
  /** Folder that holds the objects. */
  dir: string;
  /** Base URL that serves `dir`, enabling `publicUrl`. */
  publicBaseUrl?: string;
}

export function localStorage(options: LocalStorageOptions): StorageAdapter {
  const root = resolve(options.dir);
  const pathOf = (key: string) => {
    assertSafeKey(key);
    return join(root, key);
  };
  const storage: StorageAdapter = {
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, body instanceof ReadableStream ? new Response(body) : new Response(body as ConstructorParameters<typeof Response>[0]));
    },
    async get(key) {
      const file = Bun.file(pathOf(key));
      return (await file.exists()) ? file.stream() : null;
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
  if (options.publicBaseUrl) {
    const base = options.publicBaseUrl.replace(/\/+$/, "");
    storage.publicUrl = (key) => {
      assertSafeKey(key);
      return `${base}/${key}`;
    };
  }
  return storage;
}
