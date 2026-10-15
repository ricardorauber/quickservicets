import { describe, expect, test } from "bun:test";
import { createProject } from "../testing/project.ts";
import { EntityParseError } from "./errors.ts";
import { parseEntities } from "./parse-entities.ts";

const parse = (files: Record<string, string>) => parseEntities(createProject(files));
const failure = (files: Record<string, string>) => {
  try {
    parse(files);
  } catch (error) {
    expect(error).toBeInstanceOf(EntityParseError);
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};

const userBody = "{ email: string; age?: number; active: boolean; birth: Date }";

describe("type and interface declarations", () => {
  test("produce identical models", () => {
    const fromType = parse({ "entities/User.ts": `export type User = ${userBody}` });
    const fromInterface = parse({ "entities/User.ts": `export interface User ${userBody}` });
    expect(fromInterface).toEqual(fromType);
    expect(fromType).toEqual([
      {
        key: "User",
        entityName: "User",
        name: "users",
        repoKey: "users",
        tableName: "users",
        fields: [
          { name: "email", type: "string", optional: false, storage: "column" },
          { name: "age", type: "number", optional: true, storage: "column" },
          { name: "active", type: "boolean", optional: false, storage: "column" },
          { name: "birth", type: "date", optional: false, storage: "column" },
        ],
      },
    ]);
  });
});

test("derives names for multi-word entities", () => {
  const [model] = parse({ "entities/BlogPost.ts": "export type BlogPost = { title: string }" });
  expect(model).toMatchObject({ name: "blog-posts", repoKey: "blogPosts", tableName: "blog_posts" });
});

describe("@collection", () => {
  test("replaces the derived name", () => {
    const [model] = parse({ "entities/Person.ts": "/** @collection people */\nexport type Person = { name: string }" });
    expect(model).toMatchObject({ name: "people", repoKey: "people", tableName: "people" });
  });

  test("rejects invalid names", () => {
    const message = failure({ "entities/Person.ts": "/** @collection People */\nexport type Person = { name: string }" });
    expect(message).toContain("entities/Person.ts");
  });
});

describe("file and export errors", () => {
  test("lowercase file names", () => {
    expect(failure({ "entities/user.ts": "export type User = { a: string }" })).toContain("entities/user.ts");
  });
  test("export name mismatch", () => {
    expect(failure({ "entities/User.ts": "export type Account = { a: string }" })).toContain("entities/User.ts");
  });
  test("missing export", () => {
    expect(failure({ "entities/User.ts": "type User = { a: string }" })).toContain("entities/User.ts");
  });
  test("more than one exported type", () => {
    const message = failure({ "entities/User.ts": "export type User = { a: string }\nexport type Extra = { b: string }" });
    expect(message).toContain("entities/User.ts");
  });
  test("alias that is not an object literal", () => {
    expect(failure({ "entities/User.ts": "export type User = string" })).toContain("entities/User.ts");
  });
});

describe("field types", () => {
  test("unsupported type names file, field and type", () => {
    const message = failure({ "entities/User.ts": "export type User = { big: bigint }" });
    expect(message).toContain("entities/User.ts");
    expect(message).toContain('"big"');
    expect(message).toContain('"bigint"');
  });
});

test.each(["id", "createdAt", "updatedAt"])("system field %s is rejected", (field) => {
  expect(failure({ "entities/User.ts": `export type User = { ${field}: string }` })).toContain(field);
});

test("collection name collisions name both files", () => {
  const message = failure({
    "entities/Person.ts": "/** @collection users */\nexport type Person = { name: string }",
    "entities/User.ts": "export type User = { name: string }",
  });
  expect(message).toContain("entities/Person.ts");
  expect(message).toContain("entities/User.ts");
});

test("models are JSON-serializable", () => {
  const models = parse({ "entities/User.ts": `export type User = ${userBody}` });
  expect(JSON.parse(JSON.stringify(models))).toEqual(models);
});
