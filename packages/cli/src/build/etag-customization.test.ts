import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (etag = "{}") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), etag: ${etag} });
`;
const files = (etag = "{}", note = "/** @etag off */") => ({
  "quickservice.config.ts": config(etag),
  "entities/User.ts": "export type User = { name: string };\n",
  "entities/Note.ts": `${note}\nexport type Note = { text: string };\n`,
  "entities/Document.ts": "export type Document = {\n  title: string;\n  /** @default 1 */\n  version: number;\n};\n",
});
const send = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const create = async (service: TestService, path: string, body: unknown) => {
  const response = await service.fetch(path, send("POST", body));
  return { ...((await response.json()) as { id: string }), tag: response.headers.get("etag") };
};
const g = globalThis as unknown as { notModified?: unknown[] };

describe("variables and tags", () => {
  test("QS_ETAG_REQUIRED=true makes writes without If-Match 428; QS_ETAG_ENABLED=false removes tags", async () => {
    const strict = await startTestService({ files: files("{}", ""), env: { QS_ETAG_REQUIRED: "true" } });
    try {
      const user = await create(strict, "/users", { name: "a" });
      expect((await strict.fetch(`/users/${user.id}`, send("PATCH", { name: "b" }))).status).toBe(428);
    } finally {
      await strict.stop();
    }
    const { "entities/Note.ts": _note, ...untagged } = files();
    const off = await startTestService({ files: untagged, env: { QS_ETAG_ENABLED: "false" } });
    try {
      const user = await create(off, "/users", { name: "a" });
      expect(user.tag).toBeNull();
      expect((await off.fetch(`/users/${user.id}`)).headers.get("etag")).toBeNull();
    } finally {
      await off.stop();
    }
  });

  test("@etag off removes Note's tags and conditions while User keeps them; @etag required=false exempts Note under a global required", async () => {
    const service = await startTestService({ files: files() });
    try {
      const note = await create(service, "/notes", { text: "n" });
      const user = await create(service, "/users", { name: "u" });
      expect(note.tag).toBeNull();
      expect((await service.fetch(`/notes/${note.id}`)).headers.get("etag")).toBeNull();
      expect((await service.fetch(`/notes/${note.id}`, send("PATCH", { text: "m" }, { "if-match": '"stale"' }))).status).toBe(200);
      expect(user.tag).toMatch(/^".{22}"$/);
    } finally {
      await service.stop();
    }
    const exempt = await startTestService({ files: files("{ required: true }", "/** @etag required=false */") });
    try {
      const note = await create(exempt, "/notes", { text: "n" });
      expect((await exempt.fetch(`/notes/${note.id}`, send("PATCH", { text: "m" }))).status).toBe(200);
      const user = await create(exempt, "/users", { name: "u" });
      expect((await exempt.fetch(`/users/${user.id}`, send("PATCH", { name: "v" }))).status).toBe(428);
    } finally {
      await exempt.stop();
    }
  });
});

describe("per request", () => {
  test("a required function asks If-Match of web clients only", async () => {
    const service = await startTestService({ files: files(`{ required: ({ req }) => req?.headers.get("x-client") === "web" }`) });
    try {
      const user = await create(service, "/users", { name: "a" });
      expect((await service.fetch(`/users/${user.id}`, send("PATCH", { name: "b" }, { "x-client": "web" }))).status).toBe(428);
      expect((await service.fetch(`/users/${user.id}`, send("PATCH", { name: "b" }, { "x-client": "mobile" }))).status).toBe(200);
    } finally {
      await service.stop();
    }
  });
});

describe("hooks", () => {
  test("onPreconditionFailed replaces the 412 with the current record; onNotModified runs for each 304", async () => {
    g.notModified = [];
    const service = await startTestService({
      files: files(`{
    onPreconditionFailed: async ({ entity, id, expected, current }) =>
      Response.json({ error: "stale", entity, id, expected, current }, { status: 412 }),
    onNotModified: ({ entity, id }) => void (globalThis as { notModified?: unknown[] }).notModified!.push({ entity, id }),
  }`),
    });
    try {
      const user = await create(service, "/users", { name: "a" });
      await service.fetch(`/users/${user.id}`, send("PATCH", { name: "b" }, { "if-match": user.tag! }));
      const current = (await service.fetch(`/users/${user.id}`)).headers.get("etag");
      const stale = await service.fetch(`/users/${user.id}`, send("PATCH", { name: "c" }, { "if-match": user.tag! }));
      expect(stale.status).toBe(412);
      expect(await stale.json()).toEqual({ error: "stale", entity: "User", id: user.id, expected: user.tag, current });
      for (let n = 0; n < 2; n++) expect((await service.fetch(`/users/${user.id}`, { headers: { "if-none-match": current! } })).status).toBe(304);
      expect(g.notModified).toEqual([
        { entity: "User", id: user.id },
        { entity: "User", id: user.id },
      ]);
    } finally {
      await service.stop();
    }
  });
});

describe("the tagger", () => {
  test("a tagger's tag is the header and a stale one still gets 412; a tagger without tag is a configuration error", async () => {
    const service = await startTestService({ files: files(`{ tagger: { tag: (record) => \`"v\${(record as { version?: number }).version ?? 0}"\` } }`) });
    try {
      const doc = await create(service, "/documents", { title: "Plan" });
      expect(doc.tag).toBe('"v1"');
      expect((await service.fetch(`/documents/${doc.id}`)).headers.get("etag")).toBe('"v1"');
      const updated = await service.fetch(`/documents/${doc.id}`, send("PATCH", { title: "Plan 2", version: 2 }, { "if-match": '"v1"' }));
      expect([updated.status, updated.headers.get("etag")]).toEqual([200, '"v2"']);
      const stale = await service.fetch(`/documents/${doc.id}`, send("PATCH", { title: "Lost" }, { "if-match": '"v1"' }));
      expect([stale.status, stale.headers.get("etag")]).toEqual([412, '"v2"']);
    } finally {
      await service.stop();
    }
    await expect(startTestService({ files: files("{ tagger: { compute() {} } as never }") })).rejects.toThrow(/Invalid etag\.tagger: /);
  });
});

describe("reference", () => {
  test("the reference page lists @etag, both hooks and the variables", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/etag.mdx"), "utf8");
    for (const text of ["@etag", "onPreconditionFailed", "onNotModified", "QS_ETAG_REQUIRED", "QS_ETAG_ENABLED", "etag.tagger"]) expect(page).toContain(text);
  });
});
