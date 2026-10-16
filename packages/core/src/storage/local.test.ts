import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAdapter } from "../adapters/memory.ts";
import { ConfigError, resolveConfig } from "../config.ts";
import { runStorageContract } from "../testing/storage-contract.ts";
import { localStorage } from "./local.ts";
import { extensionOf, storageKeyFor } from "./storage.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "quickservice-storage-"));

runStorageContract("local", () => localStorage({ dir: tempDir() }));

test("unsafe keys write nothing", async () => {
  const dir = tempDir();
  await expect(localStorage({ dir }).put("../etc/passwd", "x", { contentType: "text/plain", size: 1 })).rejects.toThrow();
  expect(existsSync(join(dir, "..", "etc", "passwd"))).toBe(false);
});

test("publicUrl exists only with publicBaseUrl", () => {
  expect(localStorage({ dir: tempDir() }).publicUrl).toBeUndefined();
  expect(localStorage({ dir: tempDir(), publicBaseUrl: "https://cdn.x/" }).publicUrl!("media/1/a.png")).toBe("https://cdn.x/media/1/a.png");
});

test("keys include schema, collection, id, a fresh object id and the lowercase extension", () => {
  const key = storageKeyFor({ schema: null, name: "media" }, "abc", "Photo.PNG");
  expect(key).toMatch(/^media\/abc\/[0-9a-f-]{36}\.png$/);
  expect(storageKeyFor({ schema: null, name: "media" }, "abc", "Photo.PNG")).not.toBe(key);
  expect(storageKeyFor({ schema: "auth", name: "files" }, "1", "report")).toMatch(/^auth\/files\/1\/[0-9a-f-]{36}$/);
  expect(extensionOf("../x/archive.TAR.GZ")).toBe(".gz");
  expect(extensionOf(".env")).toBe("");
});

test("storage defaults to local uploads, and a map without default fails", () => {
  const resolved = resolveConfig({ database: memoryAdapter() }, {}, tempDir());
  expect(typeof resolved.storage.default.put).toBe("function");
  expect(() => resolveConfig({ database: memoryAdapter(), storage: { s3: localStorage({ dir: tempDir() }) } }, {})).toThrow(ConfigError);
  expect(() => resolveConfig({ database: memoryAdapter(), storage: { s3: localStorage({ dir: tempDir() }) } }, {})).toThrow("storage.default");
});
