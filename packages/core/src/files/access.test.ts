import { describe, expect, test } from "bun:test";
import type { StoredRecord } from "../adapter.ts";
import { builtInFileEntity } from "../files.ts";
import type { EntityModel } from "../model.ts";
import { localStorage } from "../storage/local.ts";
import { s3Storage } from "../storage/s3.ts";
import type { StorageAdapter } from "../storage/storage.ts";
import {
  contentDisposition,
  fileAccessErrors,
  fileUrlOf,
  resolveFileAccess,
  signFile,
  verifyFileSignature,
  type FileAccessSettings,
} from "./access.ts";

const media = builtInFileEntity("media");
const withAccess = (fileAccess: EntityModel["fileAccess"]): EntityModel => ({ ...media, fileAccess });
const publicStorage = localStorage({ dir: "/tmp/unused", publicBaseUrl: "https://cdn.x/" });
const privateStorage = localStorage({ dir: "/tmp/unused" });
const files = (overrides: Partial<FileAccessSettings["files"]> = {}) => ({ signedUrlTtl: 900, ...overrides });
const record: StoredRecord = {
  id: "0190a000-0000-7000-8000-000000000001",
  storage: "default",
  storageKey: "media/0190a000-0000-7000-8000-000000000001/obj.png",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("mode and ttl", () => {
  test("the tag wins over the config, and the config over the default", () => {
    const storage = { default: publicStorage };
    expect(resolveFileAccess(media, { storage, files: files() })).toEqual({ mode: "direct", ttl: 900 });
    expect(resolveFileAccess(media, { storage, files: files({ access: "proxy", signedUrlTtl: 30 }) })).toEqual({ mode: "proxy", ttl: 30 });
    expect(resolveFileAccess(withAccess({ mode: "signed", ttl: 60 }), { storage, files: files({ access: "proxy" }) })).toEqual({
      mode: "signed",
      ttl: 60,
    });
  });

  test("without a tag or config, a storage without public URLs is reached through the proxy", () => {
    expect(resolveFileAccess(media, { storage: { default: privateStorage }, files: files() }).mode).toBe("proxy");
  });

  test("the entity's own storage decides the default", () => {
    const archived = { ...media, storageName: "archive" };
    expect(resolveFileAccess(archived, { storage: { default: privateStorage, archive: publicStorage }, files: files() }).mode).toBe("direct");
  });
});

describe("urls", () => {
  test("direct mode uses the storage's public URL", async () => {
    const url = await fileUrlOf(media, record, { storage: { default: publicStorage }, files: files() });
    expect(url).toBe(`https://cdn.x/${record.storageKey}`);
  });

  test("proxy mode uses the file route, absolute with server.publicUrl", async () => {
    const settings = { storage: { default: privateStorage }, files: files({ access: "proxy" as const }) };
    expect(await fileUrlOf(media, record, settings)).toBe(`/media/${record.id}/file`);
    expect(await fileUrlOf(media, record, { ...settings, publicUrl: "https://api.x/" })).toBe(`https://api.x/media/${record.id}/file`);
  });

  test("proxy URLs include the schema of the entity", async () => {
    const scoped = { ...media, schema: "tenant-a" };
    const url = await fileUrlOf(scoped, record, { storage: { default: privateStorage }, files: files({ access: "proxy" }) });
    expect(url).toBe(`/tenant-a/media/${record.id}/file`);
  });

  test("signed mode uses native signing when the storage has it", async () => {
    const s3 = s3Storage({ bucket: "b", endpoint: "http://localhost:9", accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" });
    const url = new URL(await fileUrlOf(withAccess({ mode: "signed", ttl: 60 }), record, { storage: { default: s3 }, files: files() }));
    expect(url.pathname).toEndWith(record.storageKey as string);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  test("signed mode without native signing signs the proxy URL", async () => {
    const settings = { storage: { default: privateStorage }, files: files({ access: "signed", signingSecret: "secret" }), now: () => 1_000_000 };
    const url = new URL(await fileUrlOf(media, record, settings), "http://x");
    expect(url.pathname).toBe(`/media/${record.id}/file`);
    expect(url.searchParams.get("expires")).toBe(String(1000 + 900));
    expect(url.searchParams.get("signature")).toBe(signFile("secret", record.id, record.storageKey as string, 1900));
  });

  test("the record's own storage is used", async () => {
    const other: StorageAdapter = { ...privateStorage, publicUrl: (key) => `https://other/${key}` };
    const settings = { storage: { default: publicStorage, other }, files: files() };
    expect(await fileUrlOf(media, { ...record, storage: "other" }, settings)).toBe(`https://other/${record.storageKey}`);
  });
});

describe("signatures", () => {
  const sign = (expires: number) => signFile("secret", "id", "key", expires);

  test("a valid signature passes until it expires", () => {
    const signature = sign(100);
    expect(verifyFileSignature("secret", "id", "key", "100", signature, 100_000)).toBe(true);
    expect(verifyFileSignature("secret", "id", "key", "100", signature, 101_000)).toBe(false);
  });

  test("tampering, a missing value or another secret fails", () => {
    const signature = sign(100);
    expect(verifyFileSignature("secret", "id", "key", "200", signature, 0)).toBe(false);
    expect(verifyFileSignature("secret", "other", "key", "100", signature, 0)).toBe(false);
    expect(verifyFileSignature("secret", "id", "other", "100", signature, 0)).toBe(false);
    expect(verifyFileSignature("other", "id", "key", "100", signature, 0)).toBe(false);
    expect(verifyFileSignature("secret", "id", "key", null, signature, 0)).toBe(false);
    expect(verifyFileSignature("secret", "id", "key", "100", null, 0)).toBe(false);
    expect(verifyFileSignature("secret", "id", "key", "1e3", signature, 0)).toBe(false);
  });

  test("signatures of another length are rejected before comparing", () => {
    expect(verifyFileSignature("secret", "id", "key", "100", sign(100).slice(1), 0)).toBe(false);
    expect(verifyFileSignature("secret", "id", "key", "100", `${sign(100)}0`, 0)).toBe(false);
  });

  test("signatures are compared in constant time", async () => {
    const source = await Bun.file(new URL("./access.ts", import.meta.url)).text();
    expect(source).toContain("timingSafeEqual(given, expected)");
  });
});

describe("configuration errors", () => {
  test("direct mode needs a storage with public URLs", () => {
    expect(fileAccessErrors(media, { storage: { default: privateStorage }, files: files({ access: "direct" }) })).toEqual([
      'entity Media uses direct file access, but storage "default" has no publicUrl',
    ]);
    expect(fileAccessErrors(media, { storage: { default: publicStorage }, files: files({ access: "direct" }) })).toEqual([]);
  });

  test("signed mode needs native signing or a secret", () => {
    const signed = withAccess({ mode: "signed" });
    expect(fileAccessErrors(signed, { storage: { default: privateStorage }, files: files() })[0]).toContain(
      "files.signingSecret is not set",
    );
    expect(fileAccessErrors(signed, { storage: { default: privateStorage }, files: files({ signingSecret: "s" }) })).toEqual([]);
    const s3 = s3Storage({ bucket: "b", endpoint: "http://localhost:9", accessKeyId: "k", secretAccessKey: "s" });
    expect(fileAccessErrors(signed, { storage: { default: s3 }, files: files() })).toEqual([]);
  });
});

test("content disposition keeps the name inline and safe", () => {
  expect(contentDisposition("report.pdf")).toBe('inline; filename="report.pdf"');
  expect(contentDisposition('a"b\\c\r\n.pdf')).toBe('inline; filename="abc.pdf"');
});
