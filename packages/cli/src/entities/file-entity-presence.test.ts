import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineFeature, loadConfig, type EntityModel } from "@quickservicets/core";
import { build, droppedFileEntityWarning } from "../build/build.ts";
import { buildSummaryLine, entityCount } from "../build/summary-line.ts";
import { listMigrations } from "../migrations/snapshot.ts";
import { run } from "../run.ts";
import { serveBuilt } from "../testing/serve.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { parseProjectEntities } from "./parse-entities.ts";

const keys = (models: EntityModel[]) => models.map((model) => model.key).sort();
const TASK = "export type Task = { title: string };\n";
const STORAGE_CONFIG = `import { defineConfig, localStorage, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), storage: { default: localStorage({ dir: "files-here" }) } });
`;

async function cli(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, cwd);
  return { code, out, err };
}

/** The models the build of `files` produces, read from `.generated/models.ts`. */
async function builtModels(files: Record<string, string>): Promise<EntityModel[]> {
  const root = createLinkedProject(files);
  try {
    await build(root, {});
    return ((await import(join(root, ".generated/models.ts"))) as { models: EntityModel[] }).models;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("when each built-in file entity is in the model", () => {
  test("an entity without file fields brings in neither", async () => {
    expect(keys(await builtModels({ "entities/Task.ts": TASK }))).toEqual(["Task"]);
  });

  test("a reference brings in only the referenced one, single or array", async () => {
    const media = 'import type { Media } from "@quickservicets/core";\nexport type Task = { title: string; photo?: Media };\n';
    expect(keys(await builtModels({ "entities/Task.ts": media }))).toEqual(["Media", "Task"]);
    const files = 'import type { File } from "@quickservicets/core";\nexport type Task = { title: string; attachments?: File[] };\n';
    expect(keys(await builtModels({ "entities/Task.ts": files }))).toEqual(["File", "Task"]);
  });

  test("setting storage brings in both", async () => {
    expect(keys(await builtModels({ "quickservicets.config.ts": STORAGE_CONFIG, "entities/Task.ts": TASK }))).toEqual(["File", "Media", "Task"]);
  });

  test("entities/File.ts brings in File, the project's own", async () => {
    const models = await builtModels({ "entities/File.ts": 'import type { File as BaseFile } from "@quickservicets/core";\nexport type File = BaseFile & { note?: string };\n' });
    expect(keys(models)).toEqual(["File"]);
    expect(models[0]!.fields.map((entry) => entry.name)).toContain("note");
  });

  test("an entity extending Media is a file entity of its own and brings in neither built-in", async () => {
    const models = await builtModels({ "entities/Avatar.ts": 'import type { Media } from "@quickservicets/core";\nexport type Avatar = Media & { alt?: string };\n' });
    expect(keys(models)).toEqual(["Avatar"]);
    expect(models[0]!.file).toEqual({ base: "media" });
  });

  test("an enabled feature's fileEntities, and a feature entity's reference, bring them in", async () => {
    const feature = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "uploads", enabledByDefault: true, fileEntities: ["file"] });
`;
    expect(keys(await builtModels({ "features/uploads/index.ts": feature, "entities/Task.ts": TASK }))).toEqual(["File", "Task"]);
    const disabled = `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ uploads: false });\n`;
    expect(keys(await builtModels({ "quickservicets.config.ts": disabled, "features/uploads/index.ts": feature, "entities/Task.ts": TASK }))).toEqual(["Task"]);
    const contributing = `import { defineFeature, entityModel, field } from "@quickservicets/core";
export default defineFeature({ key: "gallery", enabledByDefault: true, entities: [entityModel("Picture", { image: field({ type: "ref", target: "Media" }) })] });
`;
    expect(keys(await builtModels({ "features/gallery/index.ts": contributing }))).toEqual(["Media", "Picture"]);
  });
});

describe("the fileEntities field", () => {
  test("accepts a list or a function of the resolved options", async () => {
    expect(defineFeature({ key: "a", fileEntities: ["file", "media"] }).fileEntities).toEqual(["file", "media"]);
    const feature = `import { boolean, defineFeature, object } from "@quickservicets/core";
export default defineFeature({ key: "photos", options: object({ store: boolean().default(false) }), fileEntities: (options) => (options.store ? ["media"] : []) });
`;
    const on = `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ photos: { store: true } });\n`;
    const off = `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ photos: {} });\n`;
    expect(keys(await builtModels({ "quickservicets.config.ts": on, "features/photos/index.ts": feature }))).toEqual(["Media"]);
    expect(keys(await builtModels({ "quickservicets.config.ts": off, "features/photos/index.ts": feature }))).toEqual([]);
  });

  test("defineFeature rejects an unknown entry naming the field", () => {
    expect(() => defineFeature({ key: "a", fileEntities: ["image"] as never })).toThrow('Invalid feature a: fileEntities has an invalid entry "image"; expected "file" or "media"');
    expect(() => defineFeature({ key: "a", fileEntities: "file" as never })).toThrow("fileEntities");
  });

  test("a function returning an unknown entry fails the build naming the feature and the field", async () => {
    const feature = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "bad", enabledByDefault: true, fileEntities: () => ["image"] as never });
`;
    await expect(builtModels({ "features/bad/index.ts": feature })).rejects.toThrow('Invalid feature bad: fileEntities has an invalid entry "image"');
  });
});

describe("an absent built-in file entity", () => {
  test("has no routes, repository, OpenAPI path or schema, and no uploads folder", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, "entities/Task.ts": TASK });
    try {
      await build(root, {});
      const types = readFileSync(join(root, ".generated/types.ts"), "utf8");
      expect(types).toContain("tasks: Repository<");
      expect(types).not.toMatch(/\bfiles: Repository</);
      expect(types).not.toMatch(/\bmedia: Repository</);
      const openApi = JSON.parse(readFileSync(join(root, ".generated/openapi.json"), "utf8")) as { paths: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
      expect(Object.keys(openApi.paths).some((path) => path.startsWith("/files") || path.startsWith("/media"))).toBe(false);
      expect(Object.keys(openApi.components?.schemas ?? {}).some((name) => /^(File|Media)\b/.test(name))).toBe(false);
      const app = await serveBuilt(root);
      expect((await app.get("/files")).status).toBe(404);
      expect((await app.get("/media")).status).toBe(404);
      expect((await app.request("POST", "/tasks", { title: "a" })).status).toBe(201);
      expect(existsSync(join(root, "uploads"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parseProjectEntities without usage leaves both out", () => {
    const root = createLinkedProject({ "entities/Task.ts": TASK });
    expect(keys(parseProjectEntities(root))).toEqual(["Task"]);
    expect(keys(parseProjectEntities(root, [], { storage: true }))).toEqual(["File", "Media", "Task"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the build summary", () => {
  test("counts the entities in the model, singular for one", async () => {
    expect([0, 1, 2].map(entityCount)).toEqual(["0 entities", "1 entity", "2 entities"]);
    expect(buildSummaryLine({ entities: 1, endpoints: 0, hooks: 0 })).toBe("Built 1 entity, 0 custom endpoints and 0 hooks.");
    expect(buildSummaryLine({ entities: 2, endpoints: 1, hooks: 1, features: 1 })).toBe("Built 2 entities, 1 custom endpoints, 1 hooks and 1 project features.");
    const root = createLinkedProject({ "entities/Task.ts": TASK });
    try {
      expect((await cli(["build"], root)).out).toContain("Built 1 entity, 0 custom endpoints and 0 hooks.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("existing File and Media tables", () => {
  test("warn once per entity, are kept by the build, and migration add proposes dropping them", async () => {
    const sqlite = `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: \`\${import.meta.dir}/data.db\` }) });\n`;
    const using = 'import type { File, Media } from "@quickservicets/core";\nexport type Task = { title: string; photo?: Media; contract?: File };\n';
    const root = createLinkedProject({ "quickservicets.config.ts": sqlite, "entities/Task.ts": using });
    try {
      expect((await cli(["build"], root)).code).toBe(0);
      expect((await cli(["migration", "add", "Init"], root)).code).toBe(0);
      const migrated = await cli(["migrate"], root);
      expect([migrated.code, migrated.err.join("\n")]).toEqual([0, ""]);
      await Bun.write(join(root, "entities/Task.ts"), TASK);
      const built = await cli(["build"], root);
      expect(built.code).toBe(0);
      const warnings = built.err.filter((line) => line.includes("is no longer built"));
      expect(warnings).toEqual([`Warning: ${droppedFileEntityWarning("File", "files")}`, `Warning: ${droppedFileEntityWarning("Media", "media")}`]);
      expect(droppedFileEntityWarning("Media", "media")).toBe("Media is no longer built because no entity, storage or feature uses it; the next migration add will propose dropping media; set storage in quickservicets.config.ts to keep it");
      const tables = () => new Database(join(root, "data.db"), { readonly: true }).query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
      expect(tables()).toEqual(expect.arrayContaining(["files", "media"]));
      const added = await cli(["migration", "add", "DropUploads"], root);
      expect(added.code).toBe(0);
      const migration = readFileSync(listMigrations(root).at(-1)!.file, "utf8");
      expect(migration).toContain("DROP TABLE `{{default_schema}}files`");
      expect(migration).toContain("DROP TABLE `{{default_schema}}media`");
      expect(tables()).toEqual(expect.arrayContaining(["files", "media"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("a service with only the defaults", () => {
  test("builds 0 entities and serves only the API docs outside production", async () => {
    const root = createLinkedProject({});
    try {
      expect((await cli(["build"], root)).out).toContain("Built 0 entities, 0 custom endpoints and 0 hooks.");
      expect(((await import(join(root, ".generated/models.ts"))) as { models: unknown[] }).models).toEqual([]);
      const app = await serveBuilt(root);
      expect((await app.server.fetch(new Request("http://localhost/docs"))).status).toBe(200);
      const openApi = await app.get("/openapi.json");
      expect(openApi.status).toBe(200);
      expect(openApi.body.paths).toEqual({});
      for (const path of ["/files", "/media", "/tasks", "/"]) expect(await app.get(path)).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "Route not found" } } });
      const production = await serveBuilt(root, { NODE_ENV: "production" });
      expect((await production.get("/docs")).status).toBe(404);
      expect((await production.get("/openapi.json")).status).toBe(404);
      expect((await loadConfig(root, {})).database.kind).toBe("memory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a defineConfig({}) project is the same", async () => {
    expect(await builtModels({ "quickservicets.config.ts": 'import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({});\n' })).toEqual([]);
  });
});
