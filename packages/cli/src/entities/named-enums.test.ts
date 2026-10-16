import { describe, expect, test } from "bun:test";
import { createApp, memoryAdapter, resolveConfig } from "@quickservice/core";
import { planMigration } from "../migrations/add.ts";
import { createProject } from "../testing/project.ts";
import { parseEntities, parseProjectEntities } from "./parse-entities.ts";

const STATUS = 'export enum Status { Draft = "draft", Published = "published" }';

const fieldOf = (files: Record<string, string>, entity: string, name: string) =>
  parseEntities(createProject(files))
    .find((model) => model.entityName === entity)!
    .fields.find((field) => field.name === name)!;

describe("enums", () => {
  test("a string enum in the entity file maps to an enum field", () => {
    const field = fieldOf({ "entities/Post.ts": `${STATUS}\nexport type Post = { status: Status }` }, "Post", "status");
    expect(field).toMatchObject({
      type: "enum",
      values: ["draft", "published"],
      declaration: { name: "Status", file: "entities/Post.ts" },
    });
  });

  test("a const enum imported from another file maps the same way", () => {
    const field = fieldOf(
      {
        "shared/status.ts": 'export const enum Status { Draft = "draft", Published = "published" }',
        "entities/Post.ts": 'import { Status } from "../shared/status.ts";\nexport type Post = { status: Status }',
      },
      "Post",
      "status",
    );
    expect(field).toMatchObject({ type: "enum", values: ["draft", "published"], declaration: { name: "Status", file: "shared/status.ts" } });
  });
});

test("an enum-only file in /entities is shared, not an entity", () => {
  const models = parseEntities(
    createProject({
      "entities/ModuleAction.ts": "export enum ModuleAction {\n  manage,\n  view\n}",
      "entities/Visibility.ts": 'export type Visibility = "public" | "private";',
      "entities/Profile.ts": 'import { ModuleAction } from "./ModuleAction";\nimport type { Visibility } from "./Visibility";\nexport type Profile = { action: ModuleAction; visibility: Visibility }',
    }),
  );
  expect(models.map((model) => model.entityName)).toEqual(["Profile"]);
  expect(models[0]!.fields.map((field) => (field as { values?: string[] }).values)).toEqual([["manage", "view"], ["public", "private"]]);
  expect(() => parseEntities(createProject({ "entities/Empty.ts": "" }))).toThrow("must export exactly one entity type named Empty");
});

describe("union aliases", () => {
  test("a shared alias gives two entities the same enum field", () => {
    const files = {
      "shared/visibility.ts": 'export type Visibility = "public" | "private";',
      "entities/Post.ts": 'import type { Visibility } from "../shared/visibility.ts";\nexport type Post = { visibility: Visibility }',
      "entities/Page.ts": 'import type { Visibility } from "../shared/visibility.ts";\nexport type Page = { visibility?: Visibility }',
    };
    for (const entity of ["Post", "Page"]) {
      expect(fieldOf(files, entity, "visibility")).toMatchObject({
        type: "enum",
        values: ["public", "private"],
        declaration: { name: "Visibility", file: "shared/visibility.ts" },
      });
    }
  });

  test("aliases of other types stay unsupported", () => {
    expect(() =>
      parseEntities(createProject({ "entities/Post.ts": "type Count = number | string;\nexport type Post = { count: Count }" })),
    ).toThrow('has unsupported type "Count"');
  });
});

describe("arrays and nested fields", () => {
  test("arrays of enums and nested enum fields", () => {
    const files = { "entities/Post.ts": `${STATUS}\nexport type Post = { history: Status[]; meta: { status: Status } }` };
    expect(fieldOf(files, "Post", "history")).toMatchObject({ type: "array", items: { type: "enum", values: ["draft", "published"] } });
    const meta = fieldOf(files, "Post", "meta") as { fields: unknown[] };
    expect(meta.fields[0]).toMatchObject({ name: "status", type: "enum", declaration: { name: "Status" } });
  });
});

describe("build errors", () => {
  const parse = (source: string) => () => parseEntities(createProject({ "entities/Post.ts": `${source}\nexport type Post = { level: Level }` }));

  test("unexported enums and aliases", () => {
    expect(parse('enum Level { Low = "low" }')).toThrow('entities/Post.ts: field "level" uses Level, which must be exported');
    expect(parse('type Level = "low" | "high";')).toThrow('field "level" uses Level, which must be exported');
  });

  test("numeric and mixed members", () => {
    const message = 'entities/Post.ts: field "level" uses enum Level, whose members must all have string values or all have none';
    expect(parse("export enum Level { Low = 1 }")).toThrow(message);
    expect(parse('export enum Level { Low, High = "high" }')).toThrow(message);
  });

  test("repeated values", () => {
    expect(parse('export enum Level { A = "x", B = "x" }')).toThrow('field "level" uses enum Level, which repeats the value "x"');
  });
});

describe("defaults", () => {
  const defaultOf = (tag: string) =>
    fieldOf({ "entities/Post.ts": `${STATUS}\nexport enum Other { Draft = "other" }\nexport type Post = {\n  /** @default ${tag} */\n  status: Status;\n}` }, "Post", "status").default;

  test("by value or by member", () => {
    expect(defaultOf("Status.Draft")).toBe("draft");
    expect(defaultOf("'draft'")).toBe("draft");
  });

  test("unknown members and other enums fail", () => {
    expect(() => defaultOf("Status.Missing")).toThrow('has invalid @default: "Status.Missing" is not a valid literal');
    expect(() => defaultOf("Other.Draft")).toThrow('has invalid @default: "Other.Draft" is not a valid literal');
  });
});

describe("recorded declarations", () => {
  test("inline unions record none", () => {
    expect(fieldOf({ "entities/Post.ts": 'export type Post = { status: "draft" | "published" }' }, "Post", "status")).not.toHaveProperty("declaration");
  });

  test("schema and migration match the inline union", async () => {
    const namedRoot = createProject({ "entities/Post.ts": `${STATUS}\nexport type Post = { status: Status }` });
    const inlineRoot = createProject({ "entities/Post.ts": 'export type Post = { status: "draft" | "published" }' });
    for (const dialect of ["sqlite", "postgres"] as const) {
      const named = await planMigration(namedRoot, parseProjectEntities(namedRoot), dialect);
      const inline = await planMigration(inlineRoot, parseProjectEntities(inlineRoot), dialect);
      expect(named.up).toEqual(inline.up);
      expect(named.up.join("\n")).toContain("'draft'");
    }
  });
});

describe("implicit enums", () => {
  const PROFILE = "export enum Profile {\n  systemAdmin,\n  organizationAdmin,\n  brandAdmin,\n  brandEditor,\n  brandViewer\n}";

  test("member names become the values", () => {
    const field = fieldOf({ "entities/Member.ts": `${PROFILE}\nexport type Member = { profile: Profile }` }, "Member", "profile");
    expect(field).toMatchObject({
      type: "enum",
      values: ["systemAdmin", "organizationAdmin", "brandAdmin", "brandEditor", "brandViewer"],
      declaration: { name: "Profile", file: "entities/Member.ts", implicit: true },
    });
    const string = fieldOf({ "entities/Post.ts": `${STATUS}\nexport type Post = { status: Status }` }, "Post", "status") as { declaration: object };
    expect(string.declaration).not.toHaveProperty("implicit");
  });

  test("defaults by member or name", () => {
    for (const tag of ["Profile.systemAdmin", "'systemAdmin'"]) {
      const field = fieldOf({ "entities/Member.ts": `${PROFILE}\nexport type Member = {\n  /** @default ${tag} */\n  profile: Profile;\n}` }, "Member", "profile");
      expect(field.default).toBe("systemAdmin");
    }
  });
});

describe("requests", () => {
  async function serve(files: Record<string, string>) {
    const models = parseProjectEntities(createProject(files));
    const database = memoryAdapter();
    await database.connect(models);
    const config = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {});
    const { server } = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config });
    return async (method: string, path: string, body?: unknown) => {
      const response = await server.fetch(new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
  }

  test("values are validated and filtered; member names are rejected", async () => {
    const send = await serve({ "entities/Post.ts": `${STATUS}\nexport type Post = { status: Status }` });
    const wrong = await send("POST", "/posts", { status: "Draft" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details[0].message).toContain("draft, published");
    expect((await send("POST", "/posts", { status: "draft" })).status).toBe(201);
    await send("POST", "/posts", { status: "published" });
    const filtered = await send("GET", "/posts?where[status][eq]=published");
    expect(filtered.body.data.map((post: { status: string }) => post.status)).toEqual(["published"]);
  });

  test("implicit enums take names and never numbers", async () => {
    const send = await serve({ "entities/Member.ts": "export enum Profile { systemAdmin, brandEditor }\nexport type Member = { profile: Profile }" });
    expect((await send("POST", "/members", { profile: 0 })).status).toBe(400);
    expect((await send("POST", "/members", { profile: "brandEditor" })).body.profile).toBe("brandEditor");
    expect((await send("GET", "/members?where[profile][eq]=0")).status).toBe(400);
  });
});
