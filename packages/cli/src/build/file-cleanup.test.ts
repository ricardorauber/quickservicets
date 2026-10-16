import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  localStorage,
  memoryAdapter,
  resolveConfig,
  type DatabaseAdapter,
  type LogEntry,
  type ServiceConfig,
  type StorageAdapter,
} from "@quickservice/core";
import { parseEntities, parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

const entities = {
  "entities/Organization.ts": `import type { Media } from "@quickservice/core";
export type Organization = {
  name: string;
  logo?: Media;
  /** @keepFile */
  banner?: Media;
};`,
  "entities/Post.ts": 'import type { Media } from "@quickservice/core";\nexport type Post = { title: string; images?: Media[] }',
};

function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

interface SetupOptions {
  files?: ServiceConfig["files"];
  storage?: (base: StorageAdapter) => StorageAdapter;
  adapter?: (base: DatabaseAdapter) => DatabaseAdapter;
}

async function setup(options: SetupOptions = {}) {
  const models = parseProjectEntities(createProject(entities));
  const dir = mkdtempSync(join(tmpdir(), "quickservice-cleanup-"));
  const base = memoryAdapter();
  const database = options.adapter ? options.adapter(base) : base;
  const local = localStorage({ dir });
  const warnings: LogEntry[] = [];
  const config = resolveConfig(
    {
      database,
      storage: { default: options.storage ? options.storage(local) : local },
      files: options.files,
      logger: { info() {}, warn: (entry) => warnings.push(entry), error() {} },
    },
    {},
  );
  await database.connect(models);
  const { server } = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config });
  const send = async (method: string, path: string, body?: string | FormData) => {
    const response = await server.fetch(new Request(`http://x${path}`, { method, body }));
    return { status: response.status, body: response.status === 204 ? null : ((await response.json()) as Record<string, any>) };
  };
  const uploadMedia = async (method = "POST", path = "/media") => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(4)], "a.png", { type: "image/png" }));
    return (await send(method, path, form)).body!.id as string;
  };
  const json = (method: string, path: string, body: unknown) => send(method, path, JSON.stringify(body));
  const mediaExists = async (id: string) => (await send("GET", `/media/${id}`)).status === 200;
  return { send, json, uploadMedia, mediaExists, objects: () => walk(dir), warnings };
}

describe("deleting file records", () => {
  test("removes the object", async () => {
    const { send, uploadMedia, objects } = await setup();
    const id = await uploadMedia();
    expect(objects()).toHaveLength(1);
    expect((await send("DELETE", `/media/${id}`)).status).toBe(204);
    expect(objects()).toEqual([]);
  });

  test("keeps the object with deleteOnRemove off", async () => {
    const { send, uploadMedia, objects } = await setup({ files: { deleteOnRemove: false } });
    const id = await uploadMedia();
    await send("DELETE", `/media/${id}`);
    expect(objects()).toHaveLength(1);
  });

  test("references follow @onDelete first", async () => {
    const { send, json, uploadMedia, objects } = await setup();
    const id = await uploadMedia();
    const organization = (await json("POST", "/organizations", { name: "Acme", logo: id })).body!;
    expect((await send("DELETE", `/media/${id}`)).status).toBe(409);
    expect(objects()).toHaveLength(1);
    expect((await send("GET", `/organizations/${organization.id}`)).body!.logo).toBe(id);
  });
});

describe("replacing content", () => {
  test("PUT removes the previous object", async () => {
    const { uploadMedia, objects } = await setup();
    const id = await uploadMedia();
    const [first] = objects();
    await uploadMedia("PUT", `/media/${id}`);
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).not.toBe(first);
  });

  test("keeps the previous object with deleteReplaced off", async () => {
    const { uploadMedia, objects } = await setup({ files: { deleteReplaced: false } });
    const id = await uploadMedia();
    await uploadMedia("PUT", `/media/${id}`);
    expect(objects()).toHaveLength(2);
  });
});

describe("changing references", () => {
  test("the previous file is removed unless another record uses it", async () => {
    const { json, uploadMedia, mediaExists, objects } = await setup();
    const shared = await uploadMedia();
    const acme = (await json("POST", "/organizations", { name: "Acme", logo: shared })).body!;
    const globex = (await json("POST", "/organizations", { name: "Globex", logo: shared })).body!;
    await json("PATCH", `/organizations/${acme.id}`, { logo: await uploadMedia() });
    expect(await mediaExists(shared)).toBe(true);
    await json("PUT", `/organizations/${globex.id}`, { name: "Globex", logo: await uploadMedia() });
    expect(await mediaExists(shared)).toBe(false);
    expect(objects()).toHaveLength(2);
  });

  test("a file still used by another entity is kept", async () => {
    const { json, uploadMedia, mediaExists } = await setup();
    const id = await uploadMedia();
    const organization = (await json("POST", "/organizations", { name: "Acme", logo: id })).body!;
    await json("POST", "/posts", { title: "Hello", images: [id] });
    await json("PATCH", `/organizations/${organization.id}`, { logo: null });
    expect(await mediaExists(id)).toBe(true);
  });

  test("multipart updates remove the replaced file", async () => {
    const { send, json, uploadMedia, mediaExists } = await setup();
    const old = await uploadMedia();
    const organization = (await json("POST", "/organizations", { name: "Acme", logo: old })).body!;
    const form = new FormData();
    form.append("logo", new File([new Uint8Array(2)], "b.png", { type: "image/png" }));
    const patched = await send("PATCH", `/organizations/${organization.id}`, form);
    expect(patched.body!.logo).not.toBe(old);
    expect(await mediaExists(old)).toBe(false);
  });

  test("@keepFile and deleteReplaced off keep the previous file", async () => {
    const kept = await setup();
    const banner = await kept.uploadMedia();
    const organization = (await kept.json("POST", "/organizations", { name: "Acme", banner })).body!;
    await kept.json("PATCH", `/organizations/${organization.id}`, { banner: await kept.uploadMedia() });
    expect(await kept.mediaExists(banner)).toBe(true);

    const off = await setup({ files: { deleteReplaced: false } });
    const logo = await off.uploadMedia();
    const other = (await off.json("POST", "/organizations", { name: "Acme", logo })).body!;
    await off.json("PATCH", `/organizations/${other.id}`, { logo: await off.uploadMedia() });
    expect(await off.mediaExists(logo)).toBe(true);
  });
});

describe("deleting owners", () => {
  test("the owner's files go with it, except @keepFile and shared ones", async () => {
    const { send, json, uploadMedia, mediaExists, objects } = await setup();
    const logo = await uploadMedia();
    const banner = await uploadMedia();
    const shared = await uploadMedia();
    const acme = (await json("POST", "/organizations", { name: "Acme", logo, banner })).body!;
    const globex = (await json("POST", "/organizations", { name: "Globex", logo: shared })).body!;
    await json("POST", "/posts", { title: "Hello", images: [shared] });
    expect((await send("DELETE", `/organizations/${acme.id}`)).status).toBe(204);
    expect(await mediaExists(logo)).toBe(false);
    expect(await mediaExists(banner)).toBe(true);
    await send("DELETE", `/organizations/${globex.id}`);
    expect(await mediaExists(shared)).toBe(true);
    expect(objects()).toHaveLength(2);
  });

  test("deleteWithOwner off keeps them", async () => {
    const { send, json, uploadMedia, mediaExists } = await setup({ files: { deleteWithOwner: false } });
    const logo = await uploadMedia();
    const organization = (await json("POST", "/organizations", { name: "Acme", logo })).body!;
    await send("DELETE", `/organizations/${organization.id}`);
    expect(await mediaExists(logo)).toBe(true);
  });
});

describe("after commit", () => {
  test("a failed change keeps the objects", async () => {
    let failing = false;
    const { json, uploadMedia, objects } = await setup({
      adapter: (base) => ({
        ...base,
        async deleteById(entity, id) {
          if (failing && entity.entityName === "Media") throw new Error("database down");
          return base.deleteById(entity, id);
        },
      }),
    });
    const logo = await uploadMedia();
    const organization = (await json("POST", "/organizations", { name: "Acme", logo })).body!;
    const next = await uploadMedia();
    failing = true;
    expect((await json("PATCH", `/organizations/${organization.id}`, { logo: next })).status).toBe(500);
    expect(objects()).toHaveLength(2);
  });

  test("a storage failure is logged and does not change the response", async () => {
    const { send, uploadMedia, warnings } = await setup({
      storage: (base) => ({
        ...base,
        async delete() {
          throw new Error("storage down");
        },
      }),
    });
    const id = await uploadMedia();
    expect((await send("DELETE", `/media/${id}`)).status).toBe(204);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ message: "File object not deleted", storage: "default", error: "storage down" });
    expect(warnings[0]!.key).toStartWith(`media/${id}/`);
  });
});

describe("@keepFile", () => {
  test("only applies to references to file entities", () => {
    const parse = (type: string) =>
      parseEntities(createProject({ "entities/Post.ts": `export type Post = {\n  /** @keepFile */\n  value: ${type};\n}` }));
    expect(() => parse("string")).toThrow('field "value" has invalid @keepFile');
  });
});
