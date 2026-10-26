import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService, type TestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of ["quickservicets.config.ts", "tagger.ts"]) files[file] = readFileSync(join(root, file), "utf8");
  for (const entry of readdirSync(join(root, "entities"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const send = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const create = async (service: TestService) => {
  const response = await service.fetch("/documents", send("POST", { title: "Plan", body: "v1" }));
  return { id: ((await response.json()) as { id: string }).id, tag: response.headers.get("etag")! };
};

test("a conditional read answers 304", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const document = await create(service);
    const read = await service.fetch(`/documents/${document.id}`, { headers: { "if-none-match": document.tag } });
    expect([read.status, read.headers.get("etag")]).toEqual([304, document.tag]);
  } finally {
    await service.stop();
  }
});

test("of two editors of one version, the second gets 412 instead of overwriting, and a write without If-Match gets 428", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const document = await create(service);
    const first = await service.fetch(`/documents/${document.id}`, send("PATCH", { body: "Ana's edit" }, { "if-match": document.tag }));
    expect(first.status).toBe(200);
    const second = await service.fetch(`/documents/${document.id}`, send("PATCH", { body: "Bob's edit" }, { "if-match": document.tag }));
    expect([second.status, second.headers.get("etag")]).toEqual([412, first.headers.get("etag")]);
    expect(((await (await service.fetch(`/documents/${document.id}`)).json()) as { body: string }).body).toBe("Ana's edit");
    expect((await service.fetch(`/documents/${document.id}`, send("PATCH", { body: "blind" }))).status).toBe(428);
  } finally {
    await service.stop();
  }
});

test("the version tagger tags documents with their version", async () => {
  const files = exampleFiles();
  files["quickservicets.config.ts"] = files["quickservicets.config.ts"]!.replace(
    'import { defineConfig, memoryAdapter } from "@quickservicets/core";',
    'import { defineConfig, memoryAdapter } from "@quickservicets/core";\nimport { versionTagger } from "./tagger.ts";',
  ).replace("etag: {}", "etag: { tagger: versionTagger }");
  const service = await startTestService({ files });
  try {
    const document = await create(service);
    expect(document.tag).toBe('"v1"');
    const updated = await service.fetch(`/documents/${document.id}`, send("PATCH", { body: "v2", version: 2 }, { "if-match": '"v1"' }));
    expect(updated.headers.get("etag")).toBe('"v2"');
    expect((await service.fetch(`/documents/${document.id}`, send("PATCH", { body: "late" }, { "if-match": '"v1"' }))).status).toBe(412);
  } finally {
    await service.stop();
  }
});
