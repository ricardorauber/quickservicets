import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineFeature, entityModel, field, loadConfig, object, registerNative, registerProjectFeatures, string, type EntityModel } from "@quickservice/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { parseProjectModels } from "../entities/parse-entities.ts";
import { addMigration } from "../migrations/add.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { serveBuilt } from "../testing/serve.ts";
import { build } from "./build.ts";

const config = (keys = "", adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter, postgresAdapter } from "@quickservice/core";
export default defineConfig({ database: ${adapter}${keys ? `, ${keys}` : ""} });
`;
const USER = "export type User = { email: string };\n";
const project = (files: Record<string, string>, keys = "", adapter?: string) =>
  createLinkedProject({ "quickservice.config.ts": config(keys, adapter), "entities/User.ts": USER, ...files });
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const NOTE = () => entityModel("Note", { text: field({ type: "string" }) });

const registered: string[] = [];
const native = (key: string, input: Record<string, unknown>) => {
  registerNative(defineFeature({ docs: { summary: "Test native." }, key, ...input }));
  registered.push(key);
};
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
  registerProjectFeatures([]);
});

describe("object and function forms", () => {
  test("a native's entityModel list gets routes, typed repositories, docs and the feature origin", async () => {
    native("notes", { entities: [NOTE()] });
    const root = project({}, "notes: {}");
    await build(root);
    const app = await serveBuilt(root);
    expect((await app.request("POST", "/notes", { text: "Hello" })).status).toBe(201);
    expect((await app.get("/notes")).body.data.map((note: { text: string }) => note.text)).toEqual(["Hello"]);
    expect(read(root, ".generated/types.ts")).toContain("notes: Repository<Note, NoteReferences, NoteCreate, NoteUpdate>;");
    expect(JSON.parse(read(root, ".generated/openapi.json")).paths["/notes"]).toBeDefined();
    const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
    expect(models.find((model) => model.key === "Note")?.feature).toBe("notes");
    expect(models.find((model) => model.key === "User")?.feature).toBeUndefined();
  });

  test("a disabled native contributes nothing", async () => {
    native("notes", { entities: [NOTE()] });
    const root = project({});
    await build(root);
    expect(read(root, ".generated/types.ts")).not.toContain("Note");
    expect(JSON.parse(read(root, ".generated/openapi.json")).paths["/notes"]).toBeUndefined();
    expect((await (await serveBuilt(root)).get("/notes")).status).toBe(404);
  });

  test("the function form derives one model per project entity from the parsed models and options", async () => {
    native("audit", {
      options: object({ suffix: string().default("Audit") }),
      entities: ({ models, options }: { models: EntityModel[]; options: { suffix: string } }) =>
        models.filter((model) => !model.internal).map((model) => entityModel(`${model.entityName}${options.suffix}`, { entry: field({ type: "ref", target: model.key }), action: field({ type: "string" }) })),
    });
    const root = project({ "entities/Post.ts": "export type Post = { title: string };\n" }, "audit: {}");
    const { models } = parseProjectModels(root, (await loadConfig(root, {})).features);
    expect(models.filter((model) => model.feature === "audit").map((model) => model.key)).toEqual(["PostAudit", "UserAudit"]);
    expect(models.find((model) => model.key === "UserAudit")!.fields.map((item) => [item.name, item.type, item.optional, item.storage])).toEqual([
      ["entry", "ref", false, "column"],
      ["action", "string", false, "column"],
    ]);
  });

  test("invalid returned models fail the build naming the feature", async () => {
    native("audit", { entities: () => [{ ...NOTE(), entityName: "note" }] });
    expect((await failure(() => build(project({}, "audit: {}")))).message).toBe('audit: entity names must be PascalCase (got "note")');
    unregisterNative("audit");
    registered.splice(0);
    native("audit", { entities: [entityModel("Note", { owner: field({ type: "ref", target: "Nobody" }) })] });
    expect((await failure(() => build(project({}, "audit: {}")))).message).toBe('audit: entity Note: field "owner" references Nobody, which is not an entity');
    unregisterNative("audit");
    registered.splice(0);
    native("audit", { entities: [entityModel("Account", { name: field({ type: "string" }) }, { collection: "users" })] });
    expect((await failure(() => build(project({}, "audit: {}")))).message).toBe('audit: entity Account uses the collection name "users", which entities/User.ts already uses');
    unregisterNative("audit");
    registered.splice(0);
    native("audit", { entities: () => { throw new Error("no models"); } });
    expect((await failure(() => build(project({}, "audit: {}")))).message).toBe("audit: entities: no models");
  });
});

describe("folders", () => {
  const FEATURE = `import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ docs: { summary: "Test native." }, key: "notes", entities: "./entities" });\n`;

  test("a project feature's entity folder is parsed with the project's entities, references both ways", async () => {
    const root = project(
      {
        "features/notes/index.ts": FEATURE,
        "features/notes/entities/Note.ts": "/** @populate:read author */\nimport type { User } from \"../../../entities/User.ts\";\nexport type Note = { text: string; author?: User };\n",
        "entities/Task.ts": 'import type { Note } from "../features/notes/entities/Note.ts";\nexport type Task = { title: string; note: Note };\n',
      },
      "notes: {}",
    );
    await build(root);
    const app = await serveBuilt(root);
    const user = (await app.request("POST", "/users", { email: "a@b.c" })).body;
    const note = (await app.request("POST", "/notes", { text: "Hi", author: user.id })).body;
    const task = (await app.request("POST", "/tasks", { title: "Do", note: note.id })).body;
    expect((await app.get(`/tasks/${task.id}?populate=note.author`)).body.note).toMatchObject({ text: "Hi", author: { email: "a@b.c" } });
    const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
    expect(models.find((model) => model.key === "Note")?.feature).toBe("notes");
  });

  test("the folder is not read while the feature is disabled", async () => {
    const root = project({ "features/notes/index.ts": FEATURE, "features/notes/entities/Note.ts": "export type Note = { text: string };\n" });
    expect((await build(root)).entities).toBe(3);
    expect(read(root, ".generated/types.ts")).not.toContain("Note");
  });
});

describe("enabled features and order", () => {
  test("only enabled features run, after what they follow", async () => {
    const seen: string[][] = [];
    const tracker = (key: string, after: string[] = []) =>
      native(key, { after, entities: ({ models }: { models: EntityModel[] }) => (seen.push([key, ...models.filter((model) => model.feature).map((model) => model.key)]), [entityModel(`${key[0]!.toUpperCase()}${key.slice(1)}Item`, { value: field({ type: "number" }) })]) });
    tracker("second", ["first"]);
    tracker("first");
    tracker("third");
    const root = project({}, "second: {}, first: {}");
    const { models } = parseProjectModels(root, (await loadConfig(root, {})).features);
    expect(seen).toEqual([["first"], ["second", "FirstItem"]]);
    expect(models.filter((model) => model.feature).map((model) => model.key)).toEqual(["FirstItem", "SecondItem"]);
  });
});

describe("conflicts and overrides", () => {
  test("two features contributing the same entity fail naming both", async () => {
    native("notes", { entities: [NOTE()] });
    native("memos", { entities: [NOTE()] });
    expect((await failure(() => build(project({}, "notes: {}, memos: {}")))).message).toBe("Features notes and memos both contribute the entity Note");
    const FOLDER = (key: string) => `import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ docs: { summary: "Test native." }, key: "${key}", entities: "./entities" });\n`;
    const root = project(
      {
        "features/alpha/index.ts": FOLDER("alpha"),
        "features/alpha/entities/Item.ts": "export type Item = { a: string };\n",
        "features/beta/index.ts": FOLDER("beta"),
        "features/beta/entities/Item.ts": "export type Item = { b: string };\n",
      },
      "alpha: {}, beta: {}",
    );
    expect((await failure(() => build(root))).message).toBe(
      "Features alpha and beta both contribute the entity Item (features/alpha/entities/Item.ts and features/beta/entities/Item.ts)",
    );
  });

  test("a project entity file replaces the feature's entity and the build prints the override line", async () => {
    native("notes", { entities: [NOTE()] });
    const root = project({ "entities/Note.ts": "export type Note = { body: string; pinned?: boolean };\n" }, "notes: {}");
    const lines: string[] = [];
    expect(await run(["build"], { log: (line) => lines.push(line), error: (line) => lines.push(line) }, root)).toBe(0);
    expect(lines[0]).toBe("Override: entities/Note.ts replaces Note from notes");
    const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
    const note = models.find((model) => model.key === "Note")!;
    expect([note.feature, note.fields.map((item) => item.name)]).toEqual([undefined, ["body", "pinned"]]);
  });

  test("a project entity file replaces a feature folder's entity", async () => {
    const root = project(
      {
        "features/notes/index.ts": `import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ docs: { summary: "Test native." }, key: "notes", entities: "./entities" });\n`,
        "features/notes/entities/Note.ts": "export type Note = { text: string };\n",
        "entities/Note.ts": "export type Note = { body: string };\n",
      },
      "notes: {}",
    );
    expect((await build(root)).overrides).toEqual(["Override: entities/Note.ts replaces Note from notes"]);
  });
});

describe("migrations", () => {
  const adapters = {
    sqlite: 'sqliteAdapter({ path: ":memory:" })',
    postgres: 'postgresAdapter({ url: "postgres://localhost/none" })',
  };
  for (const [name, adapter] of Object.entries(adapters)) {
    test(`${name}: migration add creates the feature's table and drops it once the feature is disabled`, async () => {
      native("notes", { entities: [NOTE()] });
      const root = project({}, "notes: {}", adapter);
      const created = read(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).file);
      expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?notes/);
      // The config module is cached in this process, so the environment turns the native off.
      process.env.QS_NOTES_ENABLED = "false";
      const dropped = await addMigration(root, "RemoveNotes", new Date(Date.UTC(2026, 0, 1, 0, 0, 1)))
        .then((migration) => read(root, migration.file))
        .finally(() => delete process.env.QS_NOTES_ENABLED);
      expect(dropped.split("export async function down")[0]).toMatch(/DROP TABLE \\?[`"](\{\{default_schema\}\})?notes/);
    });
  }
});
