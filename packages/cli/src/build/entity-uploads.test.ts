import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, resolveConfig } from "@quickservicets/core";
import { parseEntities, parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

const entities = {
  "entities/Organization.ts": `import type { Media } from "@quickservicets/core";
import type { Avatar } from "./Avatar.ts";
export type Organization = {
  name: string;
  /** @unique */
  slug: string;
  /** @maxSize 1MB */
  logo?: Media;
  /** @accept image/png,image/webp */
  badge?: Avatar;
  cover?: Media;
};`,
  "entities/Avatar.ts": 'import type { Media } from "@quickservicets/core";\n/** @accept image/png,image/jpeg */\nexport type Avatar = Media & { label?: string }',
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
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-entity-uploads-"));
  const database = memoryAdapter();
  const config = resolveConfig({ database, storage: { default: localStorage({ dir }) }, logger: { info() {}, warn() {}, error() {} } }, {});
  await database.connect(models);
  const { server } = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config });
  const send = async (method: string, path: string, body?: string | FormData) => {
    const response = await server.fetch(new Request(`http://x${path}`, { method, body }));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const file = (bytes: number, type = "image/png", name = "logo.png") => new File([new Uint8Array(bytes)], name, { type });
  const form = (fields: Record<string, string | Blob | (string | Blob)[]>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) for (const item of [value].flat()) body.append(key, item);
    return body;
  };
  const count = async (path: string) => (await send("GET", path)).body.total as number;
  return { send, file, form, count, dir };
}

describe("multipart writes", () => {
  test("create uploads the logo into Media and links it", async () => {
    const { send, file, form, dir } = await setup();
    const created = await send("POST", "/organizations", form({ name: "Acme", slug: "acme", logo: file(4) }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Acme", slug: "acme" });
    const media = await send("GET", `/media/${created.body.logo}`);
    expect(media.body).toMatchObject({ id: created.body.logo, filename: "logo.png", mimeType: "image/png", size: 4 });
    expect(walk(dir)).toHaveLength(1);
  });

  test("patch and replace set new file ids", async () => {
    const { send, file, form } = await setup();
    const created = await send("POST", "/organizations", form({ name: "Acme", slug: "acme", logo: file(4) }));
    const patched = await send("PATCH", `/organizations/${created.body.id}`, form({ logo: file(5, "image/png", "next.png") }));
    expect(patched.status).toBe(200);
    expect(patched.body.logo).not.toBe(created.body.logo);
    expect((await send("GET", `/media/${patched.body.logo}`)).body.filename).toBe("next.png");
    const replaced = await send("PUT", `/organizations/${created.body.id}`, form({ data: '{"name":"Acme 2","slug":"acme"}', cover: file(3) }));
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ name: "Acme 2", logo: null });
    expect((await send("GET", `/media/${replaced.body.cover}`)).body.size).toBe(3);
  });

  test("JSON bodies still work", async () => {
    const { send } = await setup();
    const created = await send("POST", "/organizations", JSON.stringify({ name: "Acme", slug: "acme" }));
    expect(created.status).toBe(201);
  });
});

describe("field limits", () => {
  test("a field's @maxSize applies on top of the entity's limits", async () => {
    const { send, file, form, count } = await setup();
    const response = await send("POST", "/organizations", form({ name: "Acme", slug: "acme", logo: file(2 * MB) }));
    expect(response.status).toBe(413);
    expect(response.body.error).toEqual({ code: "PAYLOAD_TOO_LARGE", message: "File too large", details: [{ field: "logo", message: "File too large" }] });
    expect(await count("/media")).toBe(0);
    expect((await send("POST", "/organizations", form({ name: "Acme", slug: "acme", cover: file(2 * MB) }))).status).toBe(201);
  });

  test("a field's @accept and the target's rules must both match", async () => {
    const { send, file, form } = await setup();
    const webp = await send("POST", "/organizations", form({ name: "A", slug: "a", badge: file(4, "image/webp", "a.webp") }));
    expect(webp.status).toBe(400);
    expect(webp.body.error.details).toEqual([{ field: "badge", message: "File type not allowed" }]);
    const jpeg = await send("POST", "/organizations", form({ name: "B", slug: "b", badge: file(4, "image/jpeg", "b.jpg") }));
    expect(jpeg.body.error.details).toEqual([{ field: "badge", message: "File type not allowed" }]);
    const png = await send("POST", "/organizations", form({ name: "C", slug: "c", badge: file(4) }));
    expect(png.status).toBe(201);
    expect((await send("GET", `/avatars/${png.body.badge}`)).status).toBe(200);
  });

  test("existing files referenced by id are checked against the field's rules", async () => {
    const { send, file, form } = await setup();
    const big = await send("POST", "/media", form({ file: file(2 * MB) }));
    const small = await send("POST", "/media", form({ file: file(4) }));
    const json = await send("POST", "/organizations", JSON.stringify({ name: "Acme", slug: "acme", logo: big.body.id }));
    expect(json.status).toBe(400);
    expect(json.body.error.details).toEqual([{ field: "logo", message: "File too large" }]);
    const viaForm = await send("POST", "/organizations", form({ name: "Acme", slug: "acme", logo: big.body.id }));
    expect(viaForm.body.error.details).toEqual([{ field: "logo", message: "File too large" }]);
    const created = await send("POST", "/organizations", JSON.stringify({ name: "Acme", slug: "acme", logo: small.body.id }));
    expect(created.status).toBe(201);
    const patched = await send("PATCH", `/organizations/${created.body.id}`, JSON.stringify({ logo: big.body.id }));
    expect(patched.status).toBe(400);
    const gif = await send("POST", "/avatars", form({ file: file(4, "image/jpeg", "a.jpg") }));
    const typed = await send("PATCH", `/organizations/${created.body.id}`, JSON.stringify({ badge: gif.body.id }));
    expect(typed.body.error.details).toEqual([{ field: "badge", message: "File type not allowed" }]);
  });
});

describe("rollback", () => {
  test("a failed write removes the uploaded file records and objects", async () => {
    const { send, file, form, count, dir } = await setup();
    await send("POST", "/organizations", JSON.stringify({ name: "Acme", slug: "acme" }));
    const duplicate = await send("POST", "/organizations", form({ name: "Other", slug: "acme", logo: file(4), cover: file(3) }));
    expect(duplicate.status).toBe(409);
    expect(await count("/media")).toBe(0);
    expect(walk(dir)).toEqual([]);
  });

  test("an invalid body removes the uploaded files too", async () => {
    const { send, file, form, count, dir } = await setup();
    const invalid = await send("POST", "/organizations", form({ slug: "acme", logo: file(4) }));
    expect(invalid.status).toBe(400);
    expect(await count("/media")).toBe(0);
    expect(walk(dir)).toEqual([]);
  });
});

describe("parts", () => {
  test("a part without a file reference field is unknown", async () => {
    const { send, file, form, count } = await setup();
    const unknown = await send("POST", "/organizations", form({ name: "A", slug: "a", banner: file(4) }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([{ field: "banner", message: "Unknown field" }]);
    const notFile = await send("POST", "/organizations", form({ name: file(4), slug: "a" }));
    expect(notFile.body.error.details).toEqual([{ field: "name", message: "Unknown field" }]);
    expect(await count("/media")).toBe(0);
  });

  test("a field cannot get both a file and a value", async () => {
    const { send, file, form } = await setup();
    const media = await send("POST", "/media", form({ file: file(4) }));
    const both = await send("POST", "/organizations", form({ name: "A", slug: "a", logo: [file(4), media.body.id] }));
    expect(both.status).toBe(400);
    expect(both.body.error.details).toEqual([{ field: "logo", message: "Duplicate field" }]);
    const inData = await send("POST", "/organizations", form({ data: JSON.stringify({ name: "A", slug: "a", logo: media.body.id }), logo: file(4) }));
    expect(inData.body.error.details).toEqual([{ field: "logo", message: "Duplicate field" }]);
  });
});

describe("tags", () => {
  test("field limits are parsed", () => {
    const organization = parseEntities(createProject(entities)).find((model) => model.entityName === "Organization")!;
    expect(organization.fields.find((field) => field.name === "logo")!.fileLimits).toEqual({ maxSize: MB });
    expect(organization.fields.find((field) => field.name === "badge")!.fileLimits).toEqual({ accept: ["image/png", "image/webp"] });
  });

  test("field limits only apply to references to file entities", () => {
    const parse = (type: string) =>
      parseEntities(
        createProject({
          "entities/Tag.ts": "export type Tag = { name: string }",
          "entities/Post.ts": `import type { Tag } from "./Tag.ts";\nexport type Post = {\n  /** @maxSize 1MB */\n  value: ${type};\n}`,
        }),
      );
    expect(() => parse("string")).toThrow('field "value" has invalid @maxSize: only applies to references to file entities');
    expect(() => parse("Tag")).toThrow('field "value" has invalid @maxSize: only applies to references to file entities');
  });
});
