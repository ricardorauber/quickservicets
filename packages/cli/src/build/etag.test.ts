import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { etagOf } from "@quickservicets/core";
import { listedTags, noneMatch } from "../../../core/src/features/etag/tags.ts";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (etag = "etag: {}") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter()${etag ? `, ${etag}` : ""} });
`;
const FILES = {
  "quickservicets.config.ts": config(),
  "entities/User.ts": "export type User = { name: string; email: string };\n",
  "entities/Secret.ts": "/** @guarded:read */\nexport type Secret = { value: string };\n",
  "hooks/guarded.ts": `import { definePreHook, HttpError } from "@quickservicets/core";
export default definePreHook((_repos, req) => {
  if (req.headers.get("x-role") !== "admin") throw new HttpError(403, "Forbidden");
});
`,
  "endpoints/profiles/[id]/get.ts": `import type { Repositories, ServiceRequest, ServiceResponse } from "@quickservicets/core";
export default async (repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
  const user = await (repos as unknown as { users: { findById(id: string): Promise<{ id: string; name: string } | null> } }).users.findById(req.params.id!);
  res.etag(user!);
  return { name: user!.name };
};
`,
};
const send = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const create = async (service: TestService, path = "/users", body: unknown = { name: "Ada", email: "ada@x.io" }) => service.fetch(path, send("POST", body));

describe("tags", () => {
  test("etagOf is a quoted 22-character hash of the id and updatedAt", () => {
    const tag = etagOf({ id: "a", updatedAt: new Date(1000) });
    expect(tag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    expect(etagOf({ id: "a", updatedAt: new Date(1000), name: "x" })).toBe(tag);
    expect(etagOf({ id: "a", updatedAt: new Date(1001) })).not.toBe(tag);
    expect(etagOf({ id: "b", updatedAt: new Date(1000) })).not.toBe(tag);
  });

  test("If-None-Match lists tags separated by commas, compares weakly, and * matches", () => {
    expect(listedTags(' "a", W/"b" ')).toEqual(['"a"', 'W/"b"']);
    expect(noneMatch('"x", "a"', '"a"')).toBe(true);
    expect(noneMatch('W/"a"', '"a"')).toBe(true);
    expect(noneMatch("*", '"a"')).toBe(true);
    expect(noneMatch('"b"', '"a"')).toBe(false);
    expect(noneMatch(null, '"a"')).toBe(false);
  });
});

describe("reads and writes", () => {
  test("a read has the record's tag, field selection keeps it, a write changes it, and create returns the one a read gets", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const created = await create(service);
      expect(created.status).toBe(201);
      const user = (await created.json()) as { id: string };
      const createdTag = created.headers.get("etag");
      const read = await service.fetch(`/users/${user.id}`);
      expect(read.headers.get("etag")).toHaveLength(24);
      expect(read.headers.get("etag")).toBe(createdTag);
      expect(read.headers.get("cache-control")).toBe("private, no-cache");
      expect((await service.fetch(`/users/${user.id}?fields=name`)).headers.get("etag")).toBe(createdTag);
      const patched = await service.fetch(`/users/${user.id}`, send("PATCH", { name: "Ada L." }));
      expect(patched.headers.get("etag")).not.toBe(createdTag);
      expect((await service.fetch(`/users/${user.id}`)).headers.get("etag")).toBe(patched.headers.get("etag"));
      const replaced = await service.fetch(`/users/${user.id}`, send("PUT", { name: "A", email: "a@x.io" }));
      expect(replaced.headers.get("etag")).toMatch(/^".{22}"$/);
    } finally {
      await service.stop();
    }
  });

  test("If-None-Match with the current tag or * answers 304 without a body; an old tag 200", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const user = (await (await create(service)).json()) as { id: string };
      const tag = (await service.fetch(`/users/${user.id}`)).headers.get("etag")!;
      const notModified = await service.fetch(`/users/${user.id}`, { headers: { "if-none-match": tag } });
      expect([notModified.status, await notModified.text(), notModified.headers.get("etag")]).toEqual([304, "", tag]);
      expect((await service.fetch(`/users/${user.id}`, { headers: { "if-none-match": "*" } })).status).toBe(304);
      await service.fetch(`/users/${user.id}`, send("PATCH", { name: "B" }));
      expect((await service.fetch(`/users/${user.id}`, { headers: { "if-none-match": tag } })).status).toBe(200);
    } finally {
      await service.stop();
    }
  });

  test("a read pre-hook refusing the request still answers 403 to a matching If-None-Match", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const secret = (await (await create(service, "/secrets", { value: "s" })).json()) as { id: string };
      const tag = (await service.fetch(`/secrets/${secret.id}`, { headers: { "x-role": "admin" } })).headers.get("etag")!;
      expect((await service.fetch(`/secrets/${secret.id}`, { headers: { "if-none-match": tag } })).status).toBe(403);
      expect((await service.fetch(`/secrets/${secret.id}`, { headers: { "if-none-match": tag, "x-role": "admin" } })).status).toBe(304);
    } finally {
      await service.stop();
    }
  });
});

describe("custom endpoints", () => {
  test("res.etag(record) sets the tag and answers 304 to a matching request; without the native it throws", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const user = (await (await create(service)).json()) as { id: string };
      const profile = await service.fetch(`/profiles/${user.id}`);
      const tag = profile.headers.get("etag")!;
      expect(tag).toBe((await service.fetch(`/users/${user.id}`)).headers.get("etag")!);
      expect((await service.fetch(`/profiles/${user.id}`, { headers: { "if-none-match": tag } })).status).toBe(304);
    } finally {
      await service.stop();
    }
    const without = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("") } });
    try {
      const user = (await (await create(without)).json()) as { id: string };
      const read = await without.fetch(`/users/${user.id}`);
      expect(read.headers.get("etag")).toBeNull();
      const failed = await without.fetch(`/profiles/${user.id}`);
      expect(failed.status).toBe(500);
      expect(JSON.stringify(await failed.json())).toContain("etag is not enabled; add etag: {} to quickservicets.config.ts");
    } finally {
      await without.stop();
    }
  });
});

describe("OpenAPI", () => {
  test("the read route documents ETag, If-None-Match and 304; writes document ETag", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const doc = JSON.parse(readFileSync(join(service.root, ".generated/openapi.json"), "utf8"));
      const read = doc.paths["/users/{id}"].get;
      expect(read.parameters).toContainEqual(expect.objectContaining({ name: "If-None-Match", in: "header" }));
      expect(read.responses["304"]).toBeDefined();
      expect(read.responses["200"].headers.ETag).toBeDefined();
      expect(doc.paths["/users/{id}"].patch.responses["200"].headers.ETag).toBeDefined();
      expect(doc.paths["/users"].post.responses["201"].headers.ETag).toBeDefined();
    } finally {
      await service.stop();
    }
  });
});
