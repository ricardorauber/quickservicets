import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, resolveConfig } from "@quickservice/core";
import { fileSamples } from "@quickservice/core/testing";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

const entities = {
  "entities/Organization.ts": `import type { Media } from "@quickservice/core";
export type Organization = {
  name: string;
  /** @accept image/png,image/jpeg */
  logo?: Media;
  gallery?: Media[];
};`,
  "entities/Avatar.ts": 'import type { Media } from "@quickservice/core";\n/** @accept image/png */\nexport type Avatar = Media & { label?: string }',
};

async function setup() {
  const models = parseProjectEntities(createProject(entities));
  const dir = mkdtempSync(join(tmpdir(), "quickservice-upload-types-"));
  const database = memoryAdapter();
  const config = resolveConfig({ database, storage: { default: localStorage({ dir }) }, logger: { info() {}, warn() {}, error() {} } }, {});
  await database.connect(models);
  const { server } = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config });
  const send = async (method: string, path: string, body?: FormData) => {
    const response = await server.fetch(new Request(`http://x${path}`, { method, body }));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const form = (fields: Record<string, string | Blob | Blob[]>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) for (const item of [value].flat()) body.append(key, item);
    return body;
  };
  const upload = (path: string, file: File) => send("POST", path, form({ file }));
  return { server, send, form, upload };
}

/** A file part with the given declared type; without one, the part is sent as application/octet-stream. */
const file = (sample: keyof typeof fileSamples, name: string, type?: string) => new File([fileSamples[sample]], name, type ? { type } : {});

describe("resolved upload types", () => {
  test("PNG bytes declared as GIF fail against a field that accepts PNG", async () => {
    const { send, form } = await setup();
    const response = await send("POST", "/organizations", form({ name: "Acme", logo: file("png", "logo.png", "image/gif") }));
    expect(response).toEqual({
      status: 415,
      body: {
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "File content does not match its type",
          details: [{ field: "logo", message: "Detected image/png, declared image/gif" }],
        },
      },
    });
  });

  test("array items name their index in the mismatch", async () => {
    const { send, form } = await setup();
    const response = await send("POST", "/organizations", form({ name: "Acme", gallery: [file("png", "a.png", "image/png"), file("pdf", "b.png", "image/png")] }));
    expect(response.status).toBe(415);
    expect(response.body.error.details).toEqual([{ field: "gallery[1]", message: "Detected application/pdf, declared image/png" }]);
  });

  test("octet-stream PNG bytes are stored and served as image/png", async () => {
    const { server, upload } = await setup();
    const created = await upload("/media", file("png", "logo.bin"));
    expect(created.status).toBe(201);
    expect(created.body.mimeType).toBe("image/png");
    const served = await server.fetch(new Request(`http://x/media/${created.body.id}/file`));
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  test("GIF bytes named .png are stored as image/gif and rejected by @accept image/png", async () => {
    const { upload } = await setup();
    expect((await upload("/media", file("gif", "x.png", "image/gif"))).body.mimeType).toBe("image/gif");
    const rejected = await upload("/avatars", file("gif", "x.png", "image/gif"));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details).toEqual([{ field: "file", message: "File type not allowed" }]);
  });

  test("octet-stream GIF bytes are checked by @accept as image/gif", async () => {
    const { upload } = await setup();
    expect((await upload("/avatars", file("gif", "x.png"))).status).toBe(400);
    expect((await upload("/avatars", file("png", "x.gif"))).body.mimeType).toBe("image/png");
  });

  test("an unrecognized format keeps its declared type", async () => {
    const { upload } = await setup();
    const created = await upload("/files", file("csv", "items.csv", "text/csv"));
    expect(created.status).toBe(201);
    expect(created.body.mimeType).toBe("text/csv");
  });

  test("a reference field upload stores the resolved type", async () => {
    const { send, form } = await setup();
    const created = await send("POST", "/organizations", form({ name: "Acme", logo: file("jpeg", "logo") }));
    expect(created.status).toBe(201);
    expect((await send("GET", `/media/${created.body.logo}`)).body.mimeType).toBe("image/jpeg");
  });
});
