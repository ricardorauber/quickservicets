import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  definePreHook,
  HttpError,
  localStorage,
  memoryAdapter,
  resolveConfig,
  s3Storage,
  type ServiceConfig,
  type StorageAdapter,
} from "@quickservicets/core";
import { parseEntities, parseProjectEntities } from "../entities/parse-entities.ts";
import { createLinkedProject, createProject } from "../testing/project.ts";
import { build } from "./build.ts";

const entities = {
  "entities/Document.ts": 'import type { File } from "@quickservicets/core";\n/** @access proxy */\nexport type Document = File & { title?: string }',
  "entities/Contract.ts": 'import type { File } from "@quickservicets/core";\n/** @access signed 60 */\nexport type Contract = File & { party?: string }',
  "entities/Post.ts": 'import type { Media } from "@quickservicets/core";\nexport type Post = { title: string; cover?: Media }',
};

interface SetupOptions {
  storage?: StorageAdapter;
  files?: ServiceConfig["files"];
  server?: ServiceConfig["server"];
}

async function setup(options: SetupOptions = {}) {
  const models = parseProjectEntities(createProject(entities));
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-access-"));
  const database = memoryAdapter();
  let clock = Date.now();
  const config = resolveConfig(
    {
      database,
      storage: { default: options.storage ?? localStorage({ dir }) },
      files: { signingSecret: "test-secret", ...options.files },
      server: options.server,
      logger: { info() {}, warn() {}, error() {} },
    },
    {},
  );
  await database.connect(models);
  const authorized = definePreHook((_, req) => {
    if (req.headers.get("x-allowed") !== "yes") throw new HttpError(403, "Not allowed");
  });
  const crudRoutes = models.map((model) => ({
    method: "GET",
    path: `/${model.name}/[id]`,
    entity: model.key,
    operation: "read" as const,
    hooks: model.entityName === "Media" ? [] : [{ name: "authorized", args: [] }],
  }));
  const realNow = Date.now;
  Date.now = () => clock;
  const { server } = createApp({ models, crudRoutes, endpoints: [], hooks: new Map([["authorized", authorized]]), config });
  const request = (method: string, path: string, body?: string | FormData, headers: Record<string, string> = {}) =>
    server.fetch(new Request(new URL(path, "http://x").href, { method, body, headers: { "x-allowed": "yes", ...headers } }));
  const send = async (method: string, path: string, body?: string | FormData, headers?: Record<string, string>) => {
    const response = await request(method, path, body, headers);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const upload = (path: string, name = "logo.png", type = "image/png", method = "POST") => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3, 4])], name, { type }));
    return send(method, path, form);
  };
  return {
    send,
    request,
    upload,
    advance: (seconds: number) => (clock += seconds * 1000),
    restore: () => (Date.now = realNow),
  };
}

async function withSetup(options: SetupOptions, run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup(options);
  try {
    await run(context);
  } finally {
    context.restore();
  }
}

const cdn = (dir = mkdtempSync(join(tmpdir(), "quickservicets-cdn-"))) => localStorage({ dir, publicBaseUrl: "https://cdn.x" });

describe("direct access", () => {
  test("the url is the storage's public URL, and there is no file route", () =>
    withSetup({ storage: cdn() }, async ({ upload, send }) => {
      const created = await upload("/media");
      expect(created.body.url).toMatch(new RegExp(`^https://cdn\\.x/media/${created.body.id}/[0-9a-f-]{36}\\.png$`));
      expect(await send("GET", `/media/${created.body.id}/file`)).toEqual({
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "Route not found" } },
      });
    }));
});

describe("url in responses", () => {
  test("create, read, replace and populated reads carry the url; bodies cannot set it", () =>
    withSetup({ storage: cdn() }, async ({ upload, send }) => {
      const created = await upload("/media");
      const id = created.body.id as string;
      expect((await send("GET", `/media/${id}`)).body.url).toBe(created.body.url);
      expect((await send("GET", "/media")).body.data[0].url).toBe(created.body.url);
      const replaced = await upload(`/media/${id}`, "next.png", "image/png", "PUT");
      expect(replaced.body.url).toStartWith(`https://cdn.x/media/${id}/`);
      expect(replaced.body.url).not.toBe(created.body.url);
      const post = await send("POST", "/posts", JSON.stringify({ title: "Hello", cover: id }), { "content-type": "application/json" });
      expect((await send("GET", `/posts/${post.body.id}?populate=cover`)).body.cover.url).toBe(replaced.body.url);
      const patched = await send("PATCH", `/media/${id}`, JSON.stringify({ url: "x" }), { "content-type": "application/json" });
      expect(patched.status).toBe(400);
      expect(patched.body.error.details).toEqual([{ field: "url", message: "Field is read-only" }]);
    }));
});

describe("proxy access", () => {
  test("the url points at the file route, which streams the object with its headers", () =>
    withSetup({}, async ({ upload, request }) => {
      const created = await upload("/documents", "report.pdf", "application/pdf");
      expect(created.body.url).toBe(`/documents/${created.body.id}/file`);
      const response = await request("GET", created.body.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-length")).toBe("4");
      expect(response.headers.get("content-disposition")).toBe('inline; filename="report.pdf"');
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    }));

  test("the entity's read hooks run before streaming", () =>
    withSetup({}, async ({ upload, send }) => {
      const created = await upload("/documents", "report.pdf", "application/pdf");
      expect(await send("GET", created.body.url, undefined, { "x-allowed": "no" })).toEqual({
        status: 403,
        body: { error: { code: "FORBIDDEN", message: "Not allowed" } },
      });
    }));

  test("server.publicUrl makes the url absolute", () =>
    withSetup({ server: { publicUrl: "https://api.x" } }, async ({ upload }) => {
      const created = await upload("/documents", "report.pdf", "application/pdf");
      expect(created.body.url).toBe(`https://api.x/documents/${created.body.id}/file`);
    }));

  test("a missing record is not found", () =>
    withSetup({}, async ({ send }) => {
      expect((await send("GET", `/documents/${Bun.randomUUIDv7()}/file`)).status).toBe(404);
    }));

  test("built-in Media without public URLs falls back to the proxy", () =>
    withSetup({}, async ({ upload, request }) => {
      const created = await upload("/media");
      expect(created.body.url).toBe(`/media/${created.body.id}/file`);
      expect((await request("GET", created.body.url)).status).toBe(200);
    }));
});

describe("signed access", () => {
  const forbidden = { status: 403, body: { error: { code: "FORBIDDEN", message: "Invalid or expired signature" } } };

  test("a signed url works now, skips hooks and expires after its ttl", () =>
    withSetup({}, async ({ upload, request, send, advance }) => {
      const created = await upload("/contracts", "deal.pdf", "application/pdf");
      const url = new URL(created.body.url, "http://x");
      expect(url.pathname).toBe(`/contracts/${created.body.id}/file`);
      const now = await request("GET", created.body.url, undefined, { "x-allowed": "no" });
      expect(now.status).toBe(200);
      expect(now.headers.get("content-disposition")).toBe('inline; filename="deal.pdf"');
      advance(61);
      expect(await send("GET", created.body.url)).toEqual(forbidden);
    }));

  test("a tampered or missing signature is rejected", () =>
    withSetup({}, async ({ upload, send }) => {
      const created = await upload("/contracts", "deal.pdf", "application/pdf");
      const url = new URL(created.body.url, "http://x");
      const later = new URL(url);
      later.searchParams.set("expires", String(Number(url.searchParams.get("expires")) + 3600));
      expect(await send("GET", `${later.pathname}${later.search}`)).toEqual(forbidden);
      const flipped = new URL(url);
      const signature = url.searchParams.get("signature")!;
      flipped.searchParams.set("signature", `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`);
      expect(await send("GET", `${flipped.pathname}${flipped.search}`)).toEqual(forbidden);
      expect(await send("GET", url.pathname)).toEqual(forbidden);
      expect(await send("GET", `/contracts/${Bun.randomUUIDv7()}/file${url.search}`)).toEqual(forbidden);
    }));

  test("on S3, the url is a presigned URL", () =>
    withSetup(
      {
        storage: (() => {
          const s3 = s3Storage({ bucket: "b", endpoint: "http://localhost:9", accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" });
          const objects = new Map<string, Uint8Array>();
          return {
            ...s3,
            put: async (key: string, body: unknown) => void objects.set(key, new Uint8Array(await new Response(body as Blob).arrayBuffer())),
            get: async (key: string) => (objects.has(key) ? new Response(objects.get(key)!).body : null),
            delete: async (key: string) => void objects.delete(key),
          };
        })(),
      },
      async ({ upload }) => {
        const created = await upload("/contracts", "deal.pdf", "application/pdf");
        const url = new URL(created.body.url);
        expect(url.origin).toBe("http://localhost:9");
        expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
        expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      },
    ));
});

describe("tags", () => {
  test("@access is read with its ttl", () => {
    const models = parseEntities(createProject(entities));
    expect(models.find((model) => model.entityName === "Document")!.fileAccess).toEqual({ mode: "proxy" });
    expect(models.find((model) => model.entityName === "Contract")!.fileAccess).toEqual({ mode: "signed", ttl: 60 });
  });

  test("@access on a regular entity fails", () => {
    expect(() => parseEntities(createProject({ "entities/User.ts": "/** @access proxy */\nexport type User = { name: string }" }))).toThrow(
      "invalid @access: User is not a file entity",
    );
  });

  test("an unknown mode or a ttl outside signed mode fails", () => {
    const parse = (tag: string) =>
      parseEntities(createProject({ "entities/Doc.ts": `import type { File } from "@quickservicets/core";\n/** @access ${tag} */\nexport type Doc = File & { pages?: number }` }));
    expect(() => parse("public")).toThrow("expects direct, proxy or signed [ttlSeconds]");
    expect(() => parse("proxy 60")).toThrow("takes a ttl in seconds only in signed mode");
    expect(() => parse("signed 0")).toThrow("takes a ttl in seconds only in signed mode");
  });
});

describe("build errors", () => {
  const config = (files: string) =>
    `import { defineConfig, localStorage, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter(), storage: { default: localStorage({ dir: "uploads" }) }, files: ${files} });\n`;

  test("direct mode on a storage without public URLs names entity and storage", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config('{ access: "direct" }') });
    await expect(build(root)).rejects.toThrow('entity File uses direct file access, but storage "default" has no publicUrl');
  });

  test("signed mode without native signing needs a secret", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": config("{}"),
      "entities/Contract.ts": entities["entities/Contract.ts"],
    });
    await expect(build(root)).rejects.toThrow("entity Contract uses signed file access");
  });

  test("the default config builds", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config("{}") });
    await build(root);
  });
});
