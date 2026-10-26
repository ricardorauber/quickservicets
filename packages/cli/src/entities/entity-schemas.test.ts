import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp, createCrudRoutes, createRepositories, memoryAdapter, resolveConfig, type Repository } from "@quickservicets/core";
import { build } from "../build/build.ts";
import { generateTypesFile } from "../build/generate-types.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

const parse = (files: Record<string, string>) => parseEntities(createProject(files));
const failure = (files: Record<string, string>) => {
  try {
    parse(files);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};
const user = "export type User = { email: string }";

describe("schema sources", () => {
  test("from the folder", () => {
    const [model] = parse({ "entities/auth/User.ts": user });
    expect(model).toMatchObject({ key: "auth/User", schema: "auth", schemaKey: "auth", name: "users" });
  });
  test("from the tag", () => {
    const [model] = parse({ "entities/Invoice.ts": "/** @schema billing */\nexport type Invoice = { total: number }" });
    expect(model).toMatchObject({ schema: "billing", schemaKey: "billing" });
  });
  test("the tag wins over the folder", () => {
    const [model] = parse({ "entities/auth/Invoice.ts": "/** @schema billing */\nexport type Invoice = { total: number }" });
    expect(model!.schema).toBe("billing");
  });
  test("default schema is null", () => {
    expect(parse({ "entities/User.ts": user })[0]).toMatchObject({ schema: null });
    expect(parse({ "entities/User.ts": user })[0]).not.toHaveProperty("schemaKey");
  });
  test("kebab-case schemas get a camelCase key", () => {
    expect(parse({ "entities/user-data/User.ts": user })[0]).toMatchObject({ schema: "user-data", schemaKey: "userData" });
  });
});

describe("validation", () => {
  test("folders deeper than one level are rejected", () => {
    expect(failure({ "entities/a/b/User.ts": user })).toContain("entities/a/b");
  });
  test("invalid schema names are rejected naming file and schema", () => {
    const message = failure({ "entities/User.ts": "/** @schema Auth */\nexport type User = { email: string }" });
    expect(message).toContain("entities/User.ts");
    expect(message).toContain("Auth");
  });
});

test("route prefix and nested repository key", async () => {
  const models = parse({ "entities/auth/User.ts": user, "entities/Post.ts": "export type Post = { title: string }" });
  const adapter = memoryAdapter();
  await adapter.connect(models);
  const repos = createRepositories(models, adapter);
  expect(Object.keys(repos).sort()).toEqual(["auth", "posts"]);
  expect((repos.auth as Record<string, Repository>).users).toBeDefined();
  expect(createCrudRoutes(models, repos).map((route) => `${route.method} ${route.path}`)).toContain("GET /auth/users/[id]");
});

describe("same names across schemas", () => {
  const files = { "entities/User.ts": user, "entities/auth/User.ts": user };
  test("are allowed, with prefixed type names", () => {
    const models = parse(files);
    const types = generateTypesFile(models);
    expect(types).toContain("export type User = {");
    expect(types).toContain("export type AuthUser = {");
    expect(types).toContain("  users: Repository<User, UserReferences, UserCreate, UserUpdate>;");
    expect(types).toContain("  auth: {\n    users: Repository<AuthUser, AuthUserReferences, AuthUserCreate, AuthUserUpdate>;\n  };");
  });
  test("but not within one schema", () => {
    const message = failure({
      "entities/auth/User.ts": user,
      "entities/User.ts": "/** @schema auth @collection people */\nexport type User = { email: string }",
    });
    expect(message).toContain("entities/auth/User.ts");
    expect(message).toContain("entities/User.ts");
  });
});

test("a default-schema collection named like a schema is rejected naming both", () => {
  const message = failure({
    "entities/Account.ts": "/** @collection auth */\nexport type Account = { a: string }",
    "entities/auth/User.ts": user,
  });
  expect(message).toContain("entities/Account.ts");
  expect(message).toContain("entities/auth/User.ts");
});

test("references resolve to the right schema by import path", () => {
  const models = parse({
    "entities/User.ts": user,
    "entities/auth/User.ts": user,
    "entities/Post.ts": 'import type { User } from "./auth/User";\nexport type Post = { owner: User }',
  });
  const post = models.find((model) => model.entityName === "Post")!;
  expect(post.fields[0]).toMatchObject({ type: "ref", target: "auth/User" });
});

test("custom endpoints override schema-prefixed CRUD routes", async () => {
  const root = createLinkedProject({
    "quickservicets.config.ts": MEMORY_CONFIG,
    "entities/auth/User.ts": user,
    "endpoints/auth/users/[id]/get.ts": "export default () => ({ email: \"custom\" });",
  });
  await build(root);
  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
  const config = resolveConfig((await import(join(root, "quickservicets.config.ts"))).default, {});
  await config.database.connect(models);
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config });
  const response = await server.fetch(new Request("http://localhost/auth/users/abc"));
  expect(await response.json()).toEqual({ email: "custom" });
  expect((await server.fetch(new Request("http://localhost/auth/users"))).status).toBe(200);
});
