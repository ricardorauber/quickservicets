import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, parseSize, resolveConfig, sanitizeFilename, type DatabaseAdapter } from "@quickservice/core";
import { parseEntities, parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

const files = {
  "entities/Media.ts": 'import type { Media as BaseMedia } from "@quickservice/core";\nexport type Media = BaseMedia & { alt?: string; rank?: number }',
  "entities/Avatar.ts": 'import type { Media } from "@quickservice/core";\n/** @maxSize 1KB @accept image/png */\nexport type Avatar = Media & { label?: string }',
};

function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function setup(adapterOverride?: (base: DatabaseAdapter) => DatabaseAdapter, filesConfig?: { maxSize?: number | string }) {
  const models = parseProjectEntities(createProject(files));
  const dir = mkdtempSync(join(tmpdir(), "quickservice-uploads-"));
  const base = memoryAdapter();
  const database = adapterOverride ? adapterOverride(base) : base;
  const config = resolveConfig(
    { database, storage: { default: localStorage({ dir }) }, files: filesConfig, logger: { info() {}, warn() {}, error() {} } },
    {},
  );
  await database.connect(models);
  const crudRoutes = models.flatMap((model) =>
    (["create", "replace", "read"] as const).map((operation) => ({
      method: operation === "create" ? "POST" : operation === "replace" ? "PUT" : "GET",
      path: operation === "create" ? `/${model.name}` : `/${model.name}/[id]`,
      entity: model.key,
      operation,
      hooks: [],
    })),
  );
  const { server } = createApp({ models, crudRoutes, endpoints: [], hooks: new Map(), config });
  const send = async (method: string, path: string, body?: string | FormData, headers?: Record<string, string>) => {
    const response = await server.fetch(new Request(`http://x${path}`, { method, body, headers }));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const upload = (path: string, file?: { bytes: number; type: string; name: string }, extra: Record<string, string> = {}, method = "POST") => {
    const form = new FormData();
    if (file) form.append("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    for (const [key, value] of Object.entries(extra)) form.append(key, value);
    return send(method, path, form);
  };
  return { send, upload, dir };
}

test("uploads a file and returns its metadata", async () => {
  const { upload, dir } = await setup();
  const { status, body } = await upload("/media", { bytes: 4, type: "image/png", name: "logo.png" }, { alt: "Logo", rank: "2" });
  expect(status).toBe(201);
  expect(body).toMatchObject({ filename: "logo.png", mimeType: "image/png", size: 4, storage: "default", alt: "Logo", rank: 2 });
  expect(body).not.toHaveProperty("storageKey");
  expect(walk(dir)).toHaveLength(1);
});

describe("request shape", () => {
  test("JSON bodies are rejected with 415", async () => {
    const response = await (await setup()).send("POST", "/media", JSON.stringify({ alt: "x" }), { "content-type": "application/json" });
    expect(response).toEqual({ status: 415, body: { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Must be multipart/form-data" } } });
  });
  test("a missing file part is required", async () => {
    const response = await (await setup()).upload("/media", undefined, { alt: "x" });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([{ field: "file", message: "Is required" }]);
  });
  test("fields may come in a data part, but not twice", async () => {
    const { upload } = await setup();
    expect((await upload("/media", { bytes: 1, type: "image/png", name: "a.png" }, { data: '{"alt":"from data"}' })).body.alt).toBe("from data");
    const duplicate = await upload("/media", { bytes: 1, type: "image/png", name: "a.png" }, { alt: "x", data: '{"alt":"y"}' });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.details).toEqual([{ field: "alt", message: "Duplicate field" }]);
  });
});

describe("limits", () => {
  test("the default maximum is 10 MB and nothing is kept when exceeded", async () => {
    const { upload, dir } = await setup();
    const response = await upload("/media", { bytes: 11 * 1024 * 1024, type: "image/png", name: "big.png" });
    expect(response).toEqual({ status: 413, body: { error: { code: "PAYLOAD_TOO_LARGE", message: "File too large" } } });
    expect(walk(dir)).toEqual([]);
  });
  test("the config maximum applies", async () => {
    const { upload } = await setup(undefined, { maxSize: "2KB" });
    expect((await upload("/media", { bytes: 3000, type: "image/png", name: "a.png" })).status).toBe(413);
  });
  test("Media only accepts images, video and audio; File accepts anything", async () => {
    const { upload } = await setup();
    const pdf = { bytes: 1, type: "application/pdf", name: "a.pdf" };
    const rejected = await upload("/media", pdf);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details).toEqual([{ field: "file", message: "File type not allowed" }]);
    expect((await upload("/files", pdf)).status).toBe(201);
  });
  test("entity @maxSize and @accept", async () => {
    const { upload } = await setup();
    expect((await upload("/avatars", { bytes: 2048, type: "image/png", name: "a.png" })).status).toBe(413);
    expect((await upload("/avatars", { bytes: 10, type: "image/jpeg", name: "a.jpg" })).status).toBe(400);
    expect((await upload("/avatars", { bytes: 10, type: "image/png", name: "a.png" })).status).toBe(201);
  });
});

test("filenames are reduced to their base name", async () => {
  const { upload } = await setup();
  expect((await upload("/media", { bytes: 1, type: "image/png", name: "../../etc/x.png" })).body.filename).toBe("x.png");
  expect(sanitizeFilename("a\u0000b\u001f.png")).toBe("ab.png");
  expect(sanitizeFilename("x".repeat(300))).toHaveLength(255);
});

test("a failed insert removes the stored object", async () => {
  const { upload, dir } = await setup((base) => ({ ...base, insert: async () => { throw new Error("insert failed"); } }));
  expect((await upload("/media", { bytes: 1, type: "image/png", name: "a.png" })).status).toBe(500);
  expect(walk(dir)).toEqual([]);
});

test("PUT replaces the content and keeps the id", async () => {
  const { upload, dir } = await setup();
  const created = (await upload("/media", { bytes: 1, type: "image/png", name: "a.png" }, { alt: "first" })).body;
  const replaced = await upload(`/media/${created.id}`, { bytes: 5, type: "image/webp", name: "b.webp" }, {}, "PUT");
  expect(replaced.status).toBe(200);
  expect(replaced.body).toMatchObject({ id: created.id, filename: "b.webp", mimeType: "image/webp", size: 5, alt: null });
  expect(new Date(replaced.body.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  expect(walk(dir)).toHaveLength(2);
});

test("size units", () => {
  expect(parseSize("1KB")).toBe(1024);
  expect(parseSize("1.5 MB")).toBe(1572864);
  expect(parseSize("2GB")).toBe(2 * 1024 ** 3);
  expect(parseSize("10")).toBeUndefined();
});

test("@maxSize on a regular entity fails the build", () => {
  expect(() => parseEntities(createProject({ "entities/User.ts": "/** @maxSize 1MB */\nexport type User = { name: string }" }))).toThrow(
    "invalid @maxSize: User is not a file entity",
  );
});
