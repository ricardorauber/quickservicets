import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp, resolveConfig } from "@quickservice/core";
import { build } from "../build/build.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";
import { parseEntities, parseProjectEntities } from "./parse-entities.ts";

import type { EntityModel } from "@quickservice/core";

const byName = (models: EntityModel[], name: string) => models.find((model) => model.entityName === name)!;

describe("built-in entities", () => {
  test("File and Media exist without user files", () => {
    const models = parseProjectEntities(createProject({}));
    expect(byName(models, "File")).toMatchObject({ name: "files", file: { base: "file" } });
    expect(byName(models, "Media")).toMatchObject({ name: "media", file: { base: "media" } });
    expect(byName(models, "File").fields.map((field) => field.name)).toEqual(["filename", "mimeType", "size", "storage", "storageKey"]);
  });

  test("a project can reference Media and serve /media", async () => {
    const root = createLinkedProject({
      "quickservice.config.ts": MEMORY_CONFIG,
      "entities/Organization.ts": 'import type { Media } from "@quickservice/core";\nexport type Organization = { name: string; logo?: Media }',
    });
    await build(root);
    const { models } = await import(join(root, ".generated/models.ts"));
    const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
    const config = resolveConfig({ database: (await import(join(root, "quickservice.config.ts"))).default.database, logger: { info() {}, warn() {}, error() {} } }, {});
    await config.database.connect(models);
    const { server } = createApp({ models, crudRoutes, endpoints, hooks, config });
    expect((await server.fetch(new Request("http://x/media"))).status).toBe(200);
  });
});

describe("references", () => {
  test("to core File and Media, single and array", () => {
    const [organization] = parseEntities(
      createProject({
        "entities/Organization.ts": 'import type { Media, File as Upload } from "@quickservice/core";\nexport type Organization = { logo?: Media; gallery?: Media[]; contract?: Upload }',
      }),
    );
    expect(organization!.fields).toMatchObject([
      { name: "logo", type: "ref", target: "Media" },
      { name: "gallery", type: "refArray", target: "Media" },
      { name: "contract", type: "ref", target: "File" },
    ]);
  });
});

describe("extending", () => {
  test("built-in Media gains fields from /entities/Media.ts", () => {
    const models = parseProjectEntities(
      createProject({
        "entities/Media.ts": 'import type { Media as BaseMedia } from "@quickservice/core";\nexport type Media = BaseMedia & { alt?: string }',
      }),
    );
    const media = models.filter((model) => model.entityName === "Media");
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ name: "media", file: { base: "media" } });
    expect(media[0]!.fields.map((field) => field.name)).toEqual(["filename", "mimeType", "size", "storage", "storageKey", "alt"]);
  });

  test("user entities extending File or Media become file entities", () => {
    const models = parseEntities(
      createProject({
        "entities/Document.ts": 'import type { File } from "@quickservice/core";\nexport type Document = File & { pages?: number }',
        "entities/Photo.ts": 'import type { Media } from "@quickservice/core";\nexport interface Photo extends Media { caption?: string }',
      }),
    );
    expect(byName(models, "Document")).toMatchObject({ name: "documents", file: { base: "file" } });
    expect(byName(models, "Photo")).toMatchObject({ name: "photos", file: { base: "media" } });
    expect(byName(models, "Photo").fields.at(-1)).toMatchObject({ name: "caption" });
  });

  test("base fields cannot be redeclared", () => {
    expect(() =>
      parseEntities(createProject({ "entities/Document.ts": 'import type { File } from "@quickservice/core";\nexport type Document = File & { size: number }' })),
    ).toThrow('"size" is a base field');
  });
});

test("base fields are read-only in JSON bodies except filename on PATCH, and storageKey is never returned", async () => {
  const root = createLinkedProject({
    "quickservice.config.ts": MEMORY_CONFIG,
    "entities/Media.ts": 'import type { Media as BaseMedia } from "@quickservice/core";\nexport type Media = BaseMedia & { alt?: string }',
  });
  await build(root);
  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
  const database = (await import(join(root, "quickservice.config.ts"))).default.database;
  const config = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {});
  await database.connect(models);
  const media = models.find((model: { entityName: string }) => model.entityName === "Media");
  const at = new Date();
  await database.insert(media, { id: "m1", createdAt: at, updatedAt: at, filename: "a.png", mimeType: "image/png", size: 3, storage: "default", storageKey: "media/m1/x.png" });
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config });
  const patch = (body: unknown) => server.fetch(new Request("http://x/media/m1", { method: "PATCH", body: JSON.stringify(body) }));

  const readOnly = await patch({ size: 1 });
  expect(readOnly.status).toBe(400);
  expect(((await readOnly.json()) as { error: { details: unknown } }).error.details).toEqual([{ field: "size", message: "Field is read-only" }]);
  const renamed = (await (await patch({ filename: "b.png", alt: "logo" })).json()) as Record<string, unknown>;
  expect(renamed).toMatchObject({ filename: "b.png", alt: "logo" });
  expect(renamed).not.toHaveProperty("storageKey");
  const listed = (await (await server.fetch(new Request("http://x/media"))).json()) as { data: object[] };
  expect(listed.data[0]).not.toHaveProperty("storageKey");
});
