import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, resolveConfig } from "@quickservice/core";
import { parseEntities, parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

const entities = {
  "entities/Organization.ts": `import type { Media } from "@quickservice/core";
export type Organization = {
  name: string;
  /** @maxTotalSize 5MB @maxItems 3 @accept image/png */
  gallery?: Media[];
  /** @keepFile */
  archive?: Media[];
};`,
  "entities/Post.ts": 'import type { Media } from "@quickservice/core";\nexport type Post = { title: string; cover?: Media }',
};

const MB = 1024 * 1024;

function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function setup() {
  const models = parseProjectEntities(createProject(entities));
  const dir = mkdtempSync(join(tmpdir(), "quickservice-multi-uploads-"));
  const database = memoryAdapter();
  const config = resolveConfig({ database, storage: { default: localStorage({ dir }) }, logger: { info() {}, warn() {}, error() {} } }, {});
  await database.connect(models);
  const { server } = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config });
  const send = async (method: string, path: string, body?: string | FormData) => {
    const response = await server.fetch(new Request(`http://x${path}`, { method, body }));
    return { status: response.status, body: response.status === 204 ? null : ((await response.json()) as Record<string, any>) };
  };
  const file = (name: string, bytes = 4, type = "image/png") => new File([new Uint8Array(bytes)], name, { type });
  const form = (entries: [string, string | Blob][]) => {
    const body = new FormData();
    for (const [key, value] of entries) body.append(key, value);
    return body;
  };
  const media = async (name = "m.png") => (await send("POST", "/media", form([["file", file(name)]]))).body!.id as string;
  const filenames = async (ids: string[]) =>
    Promise.all(ids.map(async (id) => (await send("GET", `/media/${id}`)).body!.filename as string));
  const mediaCount = async () => (await send("GET", "/media")).body!.total as number;
  return { send, file, form, media, filenames, mediaCount, objects: () => walk(dir) };
}

describe("repeated parts", () => {
  test("POST uploads every part in order", async () => {
    const { send, file, form, filenames } = await setup();
    const created = await send(
      "POST",
      "/organizations",
      form([["name", "Acme"], ["gallery", file("a.png")], ["gallery", file("b.png")], ["gallery", file("c.png")]]),
    );
    expect(created.status).toBe(201);
    expect(created.body!.gallery).toHaveLength(3);
    expect(await filenames(created.body!.gallery)).toEqual(["a.png", "b.png", "c.png"]);
  });

  test("PATCH appends to the current list, or follows the value sent", async () => {
    const { send, file, form, media, filenames } = await setup();
    const m1 = await media("m1.png");
    const m2 = await media("m2.png");
    const created = (await send("POST", "/organizations", JSON.stringify({ name: "Acme", gallery: [m1, m2] }))).body!;
    const listed = await send("PATCH", `/organizations/${created.id}`, form([["data", JSON.stringify({ gallery: [m2] })], ["gallery", file("new.png")]]));
    expect(listed.body!.gallery).toHaveLength(2);
    expect(listed.body!.gallery[0]).toBe(m2);
    expect(await filenames(listed.body!.gallery)).toEqual(["m2.png", "new.png"]);
    const appended = await send("PATCH", `/organizations/${created.id}`, form([["gallery", file("last.png")]]));
    expect(await filenames(appended.body!.gallery)).toEqual(["m2.png", "new.png", "last.png"]);
    const removed = await send(
      "PATCH",
      `/organizations/${created.id}`,
      form([["data", JSON.stringify({ gallery: { remove: [m2] } })], ["gallery", file("tail.png")]]),
    );
    expect(await filenames(removed.body!.gallery)).toEqual(["new.png", "last.png", "tail.png"]);
  });

  test("form id values come first; PUT without a value keeps only the new files", async () => {
    const { send, file, form, media, filenames } = await setup();
    const m1 = await media("m1.png");
    const created = await send("POST", "/organizations", form([["name", "Acme"], ["gallery", m1], ["gallery", file("b.png")]]));
    expect(await filenames(created.body!.gallery)).toEqual(["m1.png", "b.png"]);
    const replaced = await send("PUT", `/organizations/${created.body!.id}`, form([["name", "Acme"], ["gallery", file("c.png")]]));
    expect(await filenames(replaced.body!.gallery)).toEqual(["c.png"]);
  });

  test("ids in both a form value and the data part are a duplicate", async () => {
    const { send, file, form, media } = await setup();
    const m1 = await media();
    const response = await send(
      "POST",
      "/organizations",
      form([["data", JSON.stringify({ name: "Acme", gallery: [m1] })], ["gallery", m1], ["gallery", file("a.png")]]),
    );
    expect(response.status).toBe(400);
    expect(response.body!.error.details).toEqual([{ field: "gallery", message: "Duplicate field" }]);
  });
});

describe("limits", () => {
  test("each file is checked at its index", async () => {
    const { send, file, form, mediaCount } = await setup();
    const response = await send(
      "POST",
      "/organizations",
      form([["name", "Acme"], ["gallery", file("a.png")], ["gallery", file("b.jpg", 4, "image/jpeg")]]),
    );
    expect(response.status).toBe(400);
    expect(response.body!.error.details).toEqual([{ field: "gallery[1]", message: "File type not allowed" }]);
    expect(await mediaCount()).toBe(0);
  });

  test("the total size of the uploaded files is limited", async () => {
    const { send, file, form, mediaCount, objects } = await setup();
    const response = await send(
      "POST",
      "/organizations",
      form([["name", "Acme"], ["gallery", file("a.png", 3 * MB)], ["gallery", file("b.png", 3 * MB)]]),
    );
    expect(response.status).toBe(413);
    expect(response.body!.error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: "Total upload size too large" });
    expect(await mediaCount()).toBe(0);
    expect(objects()).toEqual([]);
  });

  test("@maxItems applies to the resulting list, and nothing is kept", async () => {
    const { send, file, form, media, mediaCount, objects } = await setup();
    const existing = [await media(), await media(), await media()];
    const created = (await send("POST", "/organizations", JSON.stringify({ name: "Acme", gallery: existing }))).body!;
    const response = await send("PATCH", `/organizations/${created.id}`, form([["gallery", file("d.png")]]));
    expect(response.status).toBe(400);
    expect(response.body!.error.details).toEqual([{ field: "gallery", message: "Must have at most 3 items" }]);
    const tooMany = await send(
      "POST",
      "/organizations",
      form([["name", "B"], ...(["a", "b", "c", "d"].map((name) => ["gallery", file(`${name}.png`)]) as [string, Blob][])]),
    );
    expect(tooMany.status).toBe(400);
    expect(await mediaCount()).toBe(3);
    expect(objects()).toHaveLength(3);
  });
});

describe("cleanup", () => {
  test("files removed from the list are deleted unless used elsewhere", async () => {
    const { send, media, mediaCount, objects } = await setup();
    const m1 = await media();
    const m2 = await media();
    const m3 = await media();
    const created = (await send("POST", "/organizations", JSON.stringify({ name: "Acme", gallery: [m1, m2, m3] }))).body!;
    await send("POST", "/posts", JSON.stringify({ title: "Hello", cover: m3 }));
    await send("PATCH", `/organizations/${created.id}`, JSON.stringify({ gallery: [m2] }));
    expect((await send("GET", `/media/${m1}`)).status).toBe(404);
    expect((await send("GET", `/media/${m3}`)).status).toBe(200);
    await send("PATCH", `/organizations/${created.id}`, JSON.stringify({ gallery: { remove: [m2] } }));
    expect((await send("GET", `/media/${m2}`)).status).toBe(404);
    expect(await mediaCount()).toBe(1);
    expect(objects()).toHaveLength(1);
  });

  test("PUT replacing the list cleans up the old files", async () => {
    const { send, media } = await setup();
    const m1 = await media();
    const created = (await send("POST", "/organizations", JSON.stringify({ name: "Acme", gallery: [m1] }))).body!;
    await send("PUT", `/organizations/${created.id}`, JSON.stringify({ name: "Acme" }));
    expect((await send("GET", `/media/${m1}`)).status).toBe(404);
  });

  test("deleting the owner removes its array files, except @keepFile ones", async () => {
    const { send, media, mediaCount } = await setup();
    const gallery = [await media(), await media()];
    const archive = [await media()];
    const created = (await send("POST", "/organizations", JSON.stringify({ name: "Acme", gallery, archive }))).body!;
    expect((await send("DELETE", `/organizations/${created.id}`)).status).toBe(204);
    expect(await mediaCount()).toBe(1);
    expect((await send("GET", `/media/${archive[0]}`)).status).toBe(200);
  });
});

describe("tags", () => {
  test("array file limits are parsed", () => {
    const organization = parseEntities(createProject(entities)).find((model) => model.entityName === "Organization")!;
    const gallery = organization.fields.find((field) => field.name === "gallery")!;
    expect(gallery.fileLimits).toEqual({ maxTotalSize: 5 * MB, accept: ["image/png"] });
    expect(gallery.maxLength).toBe(3);
  });

  test("@maxTotalSize only applies to arrays of files", () => {
    const parse = (type: string) =>
      parseEntities(
        createProject({
          "entities/Tag.ts": "export type Tag = { name: string }",
          "entities/Post.ts": `import type { Media } from "@quickservice/core";\nimport type { Tag } from "./Tag.ts";\nexport type Post = {\n  /** @maxTotalSize 1MB */\n  value: ${type};\n}`,
        }),
      );
    expect(() => parse("Media")).toThrow('field "value" has invalid @maxTotalSize: only applies to arrays of files');
    expect(() => parse("Tag[]")).toThrow('field "value" has invalid @maxTotalSize: only applies to references to file entities');
    expect(() => parse("Media[]")).not.toThrow();
  });
});
