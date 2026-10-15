import { describe, expect, test } from "bun:test";
import { createProject } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

const organization = "export type Organization = { name: string }";
const parse = (files: Record<string, string>) => parseEntities(createProject(files));
const fieldOf = (files: Record<string, string>, entity: string, field: string) =>
  parse(files).find((model) => model.entityName === entity)!.fields.find((candidate) => candidate.name === field);
const failure = (files: Record<string, string>) => {
  try {
    parse(files);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};

describe("target resolution", () => {
  test("through an import from another entity file", () => {
    const files = {
      "entities/Organization.ts": organization,
      "entities/User.ts": 'import type { Organization } from "./Organization";\nexport type User = { organization: Organization }',
    };
    expect(fieldOf(files, "User", "organization")).toEqual({
      name: "organization",
      type: "ref",
      target: "Organization",
      onDelete: "restrict",
      optional: false,
      storage: "column",
    });
  });

  test("with a .ts import extension", () => {
    const files = {
      "entities/Organization.ts": organization,
      "entities/User.ts": 'import type { Organization } from "./Organization.ts";\nexport type User = { organization: Organization }',
    };
    expect(fieldOf(files, "User", "organization")).toMatchObject({ type: "ref", target: "Organization" });
  });

  test("in the same file", () => {
    const files = { "entities/Category.ts": "export interface Category { name: string; parent?: Category }" };
    expect(fieldOf(files, "Category", "parent")).toMatchObject({ type: "ref", target: "Category", optional: true });
  });
});

test("non-entity type references are rejected naming file, field and type", () => {
  const message = failure({
    "entities/User.ts": "type Account = { id: string }\nexport type User = { owner: Account }",
  });
  expect(message).toContain("entities/User.ts");
  expect(message).toContain('"owner"');
  expect(message).toContain("Account");
});

describe("@onDelete", () => {
  const withTag = (tag: string, optional = false) => ({
    "entities/Organization.ts": organization,
    "entities/User.ts": `import type { Organization } from "./Organization";\nexport type User = {\n  /** ${tag} */\n  organization${optional ? "?" : ""}: Organization\n}`,
  });

  test("defaults to restrict and accepts cascade", () => {
    expect(fieldOf(withTag("plain"), "User", "organization")).toMatchObject({ onDelete: "restrict" });
    expect(fieldOf(withTag("@onDelete cascade"), "User", "organization")).toMatchObject({ onDelete: "cascade" });
  });

  test("setNull requires an optional field", () => {
    expect(failure(withTag("@onDelete setNull"))).toContain('"organization"');
    expect(fieldOf(withTag("@onDelete setNull", true), "User", "organization")).toMatchObject({ onDelete: "setNull" });
  });

  test("invalid values are rejected", () => {
    const message = failure(withTag("@onDelete wipe"));
    expect(message).toContain("entities/User.ts");
    expect(message).toContain('"organization"');
  });
});

describe("references outside top-level fields", () => {
  const user = "export type User = { name: string }";
  test.each([
    ["nested object", "{ meta: { owner: User } }"],
    ["array of objects", "{ blocks: { author: User }[] }"],
  ])("%s is rejected", (_, body) => {
    const message = failure({
      "entities/User.ts": user,
      "entities/Post.ts": `import type { User } from "./User";\nexport type Post = ${body}`,
    });
    expect(message).toContain("entities/Post.ts");
  });
});

test("self-references are accepted", () => {
  const files = { "entities/Category.ts": "export type Category = { parent?: Category }" };
  expect(fieldOf(files, "Category", "parent")).toMatchObject({ type: "ref", target: "Category" });
});
