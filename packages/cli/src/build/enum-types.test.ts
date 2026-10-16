import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import ts from "typescript";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { generateOpenApi } from "../openapi/generate-openapi.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build, crudTable } from "./build.ts";
import { generateTypesFile } from "./generate-types.ts";

const entities = {
  "entities/enums.ts": 'export enum Status { Draft = "draft", Published = "published" }',
  "shared/visibility.ts": 'export type Visibility = "public" | "private";',
  "entities/Post.ts": `import { Status } from "./enums.ts";
import type { Visibility } from "../shared/visibility.ts";
export type Post = { title: string; status: Status; visibility?: Visibility; history: Status[]; meta?: { status: Status } };`,
  "entities/Page.ts": 'import { Status } from "./enums.ts";\nexport type Page = { status: Status }',
  "entities/Member.ts": "export enum Profile { systemAdmin, brandEditor }\nexport type Member = { profile: Profile; role: \"member\" | \"admin\" }",
};

const documentFor = (files: Record<string, string>) => {
  const models = parseProjectEntities(createProject(files));
  return generateOpenApi({ models, routes: crudTable(models), packageJson: { name: "api", version: "1.0.0" } }) as unknown as {
    components: { schemas: Record<string, any> };
  };
};

describe("generated types", () => {
  test("enum and alias fields use their declarations, imported once", () => {
    const types = generateTypesFile(parseProjectEntities(createProject(entities)));
    expect(types).toContain('import type { Status } from "../entities/enums.ts";');
    expect(types).toContain('import type { Visibility } from "../shared/visibility.ts";');
    expect(types.match(/import type \{ Status \}/g)).toHaveLength(1);
    expect(types).toContain("  status: Status;");
    expect(types).toContain("  visibility?: Visibility | null;");
    expect(types).toContain("  history: Array<Status>;");
    expect(types).toMatch(/export type PostCreate = \{\n {2}title: string;\n {2}status: Status;/);
    expect(types).toMatch(/export type PostUpdate = \{\n {2}title\?: string;\n {2}status\?: Status;/);
  });

  test("declarations sharing a name are imported under numbered aliases", () => {
    const types = generateTypesFile(
      parseProjectEntities(
        createProject({
          "entities/a/Status.ts": 'export enum Status { On = "on" }',
          "entities/b/Status.ts": 'export enum Status { Off = "off" }',
          "entities/Device.ts": 'import { Status } from "./a/Status.ts";\nimport { Status as Other } from "./b/Status.ts";\nexport type Device = { a: Status; b: Other }',
        }),
      ),
    );
    expect(types).toContain('import type { Status } from "../entities/a/Status.ts";');
    expect(types).toContain('import type { Status as Status2 } from "../entities/b/Status.ts";');
    expect(types).toContain("  b: Status2;");
  });

  test("implicit enums are unions of names and are not imported", () => {
    const types = generateTypesFile(parseProjectEntities(createProject(entities)));
    expect(types).toContain('  profile: "systemAdmin" | "brandEditor";');
    expect(types).not.toContain("import type { Profile }");
  });

  test("inline unions keep the literal union type", () => {
    const types = generateTypesFile(parseProjectEntities(createProject(entities)));
    expect(types).toContain('  role: "member" | "admin";');
  });
});

test("generated types type-check enum members and reject plain strings and numbers", async () => {
  const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, ...entities });
  await build(root);
  const check = join(root, "check.ts");
  writeFileSync(
    check,
    `import type { GeneratedRepositories } from "./.generated/types.ts";
import { Status } from "./entities/enums.ts";
import { Profile } from "./entities/Member.ts";
declare const repos: GeneratedRepositories;
void repos.posts.create({ title: "x", status: Status.Draft, history: [Status.Published] });
void repos.posts.update("id", { status: Status.Published });
// @ts-expect-error a plain string is not the enum
void repos.posts.create({ title: "x", status: "draft", history: [] });
void repos.members.create({ profile: "brandEditor", role: "admin" });
// @ts-expect-error members of an enum without initializers are numbers
void repos.members.create({ profile: Profile.brandEditor, role: "admin" });
`,
  );
  const program = ts.createProgram([check], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(check));
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
  expect(readFileSync(join(root, ".generated/types.ts"), "utf8")).toContain("Repository<Post, PostReferences, PostCreate, PostUpdate>");
});

describe("OpenAPI", () => {
  test("named enums and aliases share one schema referenced everywhere", async () => {
    const doc = documentFor(entities);
    const { schemas } = doc.components;
    expect(schemas.Status).toEqual({ type: "string", enum: ["draft", "published"] });
    expect(schemas.Visibility).toEqual({ type: "string", enum: ["public", "private"] });
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    expect(schemas.Post.properties.status).toEqual(ref("Status"));
    expect(schemas.Page.properties.status).toEqual(ref("Status"));
    expect(schemas.PostCreate.properties.status).toEqual(ref("Status"));
    expect(schemas.PostUpdate.properties.status).toEqual(ref("Status"));
    expect(schemas.Post.properties.visibility).toEqual({ oneOf: [ref("Visibility"), { type: "null" }] });
    expect(schemas.Post.properties.history).toEqual({ type: "array", items: ref("Status") });
    expect(schemas.Post.properties.meta.properties.status).toEqual(ref("Status"));
    expect((await validate(structuredClone(doc) as unknown as Record<string, unknown>)).errors).toEqual([]);
  });

  test("implicit enums list the names; inline unions stay inline", () => {
    const { schemas } = documentFor(entities).components;
    expect(schemas.Profile).toEqual({ type: "string", enum: ["systemAdmin", "brandEditor"] });
    expect(schemas.Member.properties.role).toEqual({ type: "string", enum: ["member", "admin"] });
  });

  test("names taken by entities, generated schemas or other declarations stay inline", async () => {
    const doc = documentFor({
      "entities/User.ts": "export type User = { name: string }",
      "entities/kinds.ts": 'export enum User { A = "a" }\nexport enum Error { B = "b" }\nexport enum UserCreate { C = "c" }',
      "entities/a/Mode.ts": 'export enum Mode { On = "on" }',
      "entities/b/Mode.ts": 'export enum Mode { Off = "off" }',
      "entities/Account.ts": `import { User, Error, UserCreate } from "./kinds.ts";
import { Mode } from "./a/Mode.ts";
import { Mode as Other } from "./b/Mode.ts";
export type Account = { kind: User; failure: Error; draft: UserCreate; a: Mode; b: Other };`,
    });
    const { schemas } = doc.components;
    expect(schemas.Account.properties.kind).toEqual({ type: "string", enum: ["a"] });
    expect(schemas.Account.properties.failure).toEqual({ type: "string", enum: ["b"] });
    expect(schemas.Account.properties.draft).toEqual({ type: "string", enum: ["c"] });
    expect(schemas.Account.properties.a).toEqual({ type: "string", enum: ["on"] });
    expect(schemas).not.toHaveProperty("Mode");
    expect(schemas.User.properties).toHaveProperty("name");
    expect((await validate(structuredClone(doc) as unknown as Record<string, unknown>)).errors).toEqual([]);
  });
});
