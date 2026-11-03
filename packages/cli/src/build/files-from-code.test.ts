import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile, events, fileUrl, openFile, registerProjectFeatures, transaction, type StoredRecord } from "@quickservicets/core";
import { fileSamples } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

afterEach(() => registerProjectFeatures([]));

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

/** Every file under a folder, recursively. */
const filesIn = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

async function start(keys = "", extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-files-from-code-"));
  const service = await startTestService({
    files: {
      "quickservicets.config.ts": `import { defineConfig, localStorage, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), storage: { default: localStorage({ dir: ${JSON.stringify(dir)} }) }, files: { signingSecret: "test-secret" }, logger: { info: (entry) => globalThis.fileLogs?.push(entry), warn() {}, error() {} }, ${keys} });
`,
      "entities/Document.ts": 'import type { File } from "@quickservicets/core";\n/** @maxSize 1MB */\nexport type Document = File & {\n  /** @minLength 2 */\n  title?: string;\n};\n',
      "entities/Contract.ts": 'import type { File } from "@quickservicets/core";\n/** @access signed 60 */\nexport type Contract = File & { party?: string };\n',
      "entities/Post.ts": "export type Post = { title: string };\n",
      "jobs/thumbnail.ts": `import { job } from "@quickservicets/core";
const PNG = new Uint8Array(${JSON.stringify([...fileSamples.png])});
export default job({ every: "1h" }, async (ctx) => {
  (globalThis as unknown as { jobFile: unknown }).jobFile = await ctx.files.createFile("Media", { body: PNG, filename: "cat.png" });
});
`,
      "endpoints/run-thumbnail/post.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default async (_repos: unknown, req: ServiceRequest) => req.jobs.run("thumbnail");\n',
      ...extra,
    },
  });
  running.push(service);
  return { service, dir };
}

const state = globalThis as unknown as { jobFile?: StoredRecord & { url?: string }; fileLogs: { message: string }[] };
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { status: number; message: string; details?: unknown };
  }
  throw new Error("expected a failure");
};

describe("createFile", () => {
  test("a job stores a Media record from bytes; it carries its type, size and url, and the proxy route serves it", async () => {
    state.jobFile = undefined;
    state.fileLogs = [];
    const { service } = await start();
    await service.fetch("/run-thumbnail", { method: "POST" });
    for (let index = 0; index < 100 && !state.jobFile; index++) await Bun.sleep(10);
    const record = state.jobFile!;
    expect(record).toMatchObject({ filename: "cat.png", mimeType: "image/png", size: fileSamples.png.length });
    expect(record.url).toContain(`/media/${record.id}/file`);
    const served = await service.fetch(`/media/${record.id}/file`);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(fileSamples.png);
    const logged = state.fileLogs.find((entry) => entry.message === "files.stored")!;
    expect(logged).toMatchObject({ entity: "Media", id: record.id, size: fileSamples.png.length, mimeType: "image/png" });
    expect(JSON.stringify(logged)).not.toContain("cat.png");
  });

  test("the upload rules apply: size, the Media rule and a declared type the content contradicts; nothing is left stored", async () => {
    const { dir } = await start();
    expect(await failure(createFile("Document", { body: new Uint8Array(2 * 1024 * 1024), filename: "big.bin" }))).toMatchObject({ status: 413, message: "File too large" });
    expect(await failure(createFile("Media", { body: fileSamples.pdf, filename: "doc.pdf" }))).toMatchObject({ status: 400, details: [{ field: "file", message: "File type not allowed" }] });
    expect(await failure(createFile("Media", { body: fileSamples.jpeg, filename: "x.png", mimeType: "image/png" }))).toMatchObject({ status: 415, message: "File content does not match its type" });
    expect(filesIn(dir)).toEqual([]);
  });

  test("a rolled-back transaction and a failed insert leave no record and no object; a ReadableStream stops at the limit", async () => {
    const { service, dir } = await start();
    await expect(
      transaction(async () => {
        await createFile("Document", { body: "hello", filename: "a.txt", mimeType: "text/plain" });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    await Bun.sleep(10);
    expect(filesIn(dir)).toEqual([]);
    expect((await failure(createFile("Document", { body: "hello", filename: "a.txt", mimeType: "text/plain", fields: { title: "x" } }))).status).toBe(400);
    expect(filesIn(dir)).toEqual([]);
    let produced = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 50 * 1024 * 1024) return controller.close();
        produced += chunk.length;
        controller.enqueue(chunk);
      },
    });
    expect((await failure(createFile("Document", { body: stream, filename: "huge.bin" }))).status).toBe(413);
    expect(produced).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(await (service.repos as unknown as { documents: { query(): { toArray(): Promise<unknown[]> } } }).documents.query().toArray()).toEqual([]);
  });

  test("with events, createFile emits media.created like an upload", async () => {
    const { service } = await start("events: {}");
    const seen: string[] = [];
    const stop = events.on("media.created", (event) => void seen.push(event.type));
    try {
      await createFile("Media", { body: fileSamples.png, filename: "x.png" });
      await events.idle();
    } finally {
      stop();
    }
    expect(seen).toEqual(["media.created"]);
    expect(service).toBeDefined();
  });
});

describe("openFile and fileUrl", () => {
  test("openFile streams the bytes; an unknown id is 404; a signed URL lasts expiresIn", async () => {
    const { service } = await start();
    const record = await createFile("Contract", { body: fileSamples.pdf, filename: "deal.pdf", fields: { party: "acme" } });
    const opened = await openFile(record);
    expect(opened).toMatchObject({ size: fileSamples.pdf.length, mimeType: "application/pdf", filename: "deal.pdf" });
    expect(new Uint8Array(await new Response(opened.stream).arrayBuffer())).toEqual(fileSamples.pdf);
    expect(new Uint8Array(await new Response((await openFile({ entity: "Contract", id: record.id })).stream).arrayBuffer())).toEqual(fileSamples.pdf);
    expect(await failure(openFile({ entity: "Media", id: "nope" }))).toMatchObject({ status: 404, message: "Media not found" });
    const url = await fileUrl(record, { expiresIn: "2m" });
    const expires = Number(new URL(url, "http://x").searchParams.get("expires"));
    expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(100);
    expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120);
    expect((await service.fetch(url)).status).toBe(200);
  });

  test("createFile only takes file entities: the generated union leaves Post out", async () => {
    const { service } = await start();
    const types = readFileSync(join(service.root, ".generated/types.ts"), "utf8");
    expect(types).toContain('"Document": true;');
    expect(types).toContain('"Media": true;');
    expect(types).not.toContain('"Post": true;');
    await expect(createFile("Post", { body: "x", filename: "x.txt" })).rejects.toThrow("Post is not a file entity of this project");
  });
});
