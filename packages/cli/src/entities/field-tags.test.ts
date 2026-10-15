import { describe, expect, test } from "bun:test";
import { createProject } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

const fieldOf = (declaration: string) =>
  parseEntities(createProject({ "entities/Item.ts": `export type Item = {\n${declaration}\n}` }))[0]!.fields[0]!;
const failure = (declaration: string) => {
  try {
    fieldOf(declaration);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};

describe("tags on valid field types", () => {
  test.each([
    ["/** @unique */ email: string", { unique: true }],
    ["/** @index */ score: number", { index: true }],
    ["/** @default 'member' */ role: 'admin' | 'member'", { default: "member" }],
    ["/** @minLength 3 @maxLength 50 */ name: string", { minLength: 3, maxLength: 50 }],
    ["/** @minLength 1 */ tags: string[]", { minLength: 1 }],
    ["/** @min 0 @max 120 */ age: number", { min: 0, max: 120 }],
    ["/** @format email */ email: string", { format: "email" }],
    ["/** @format url */ site: string", { format: "url" }],
    ["/** @hidden */ passwordHash: string", { hidden: true }],
  ])("%s", (declaration, expected) => {
    expect(fieldOf(declaration)).toMatchObject(expected);
  });

  test("tags apply to nested properties when meaningful", () => {
    expect(fieldOf("address: { /** @maxLength 9 */ zip: string }")).toMatchObject({
      fields: [{ name: "zip", maxLength: 9 }],
    });
  });
});

describe("tags on invalid field types", () => {
  test.each([
    "/** @unique */ address: { city: string }",
    "/** @index */ tags: string[]",
    "/** @minLength 1 */ age: number",
    "/** @min 1 */ name: string",
    "/** @format email */ age: number",
    "/** @onDelete cascade */ name: string",
    "/** @minItems 1 */ name: string",
    "address: { /** @hidden */ zip: string }",
  ])("%s is rejected naming file, field and tag", (declaration) => {
    const message = failure(declaration);
    expect(message).toContain("entities/Item.ts");
    expect(message).toMatch(/field "[\w.]+"/);
    expect(message).toMatch(/@\w+/);
  });
});

describe("@default type matching", () => {
  test.each([
    ["name: string", "'x'", "x"],
    ["count: number", "3", 3],
    ["active: boolean", "true", true],
    ["role: 'a' | 'b'", "'b'", "b"],
    ["tags: string[]", "[]", []],
    ["tags: string[]", '["a"]', ["a"]],
  ])("%s accepts %s", (declaration, literal, expected) => {
    expect(fieldOf(`/** @default ${literal} */ ${declaration}`).default).toEqual(expected);
  });

  test.each([
    ["name: string", "3"],
    ["count: number", "'3'"],
    ["active: boolean", "'yes'"],
    ["role: 'a' | 'b'", "'c'"],
    ["tags: string[]", "[1]"],
    ["name: string", "not json"],
  ])("%s rejects %s", (declaration, literal) => {
    expect(failure(`/** @default ${literal} */ ${declaration}`)).toContain("@default");
  });
});

test.each([
  "/** @minLength 5 @maxLength 2 */ name: string",
  "/** @min 10 @max 1 */ age: number",
])("min greater than max is rejected: %s", (declaration) => {
  expect(failure(declaration)).toContain("greater than");
});

test.each([
  ["/** @minLength -1 */ name: string", "@minLength"],
  ["/** @min abc */ age: number", "@min"],
  ["/** @format phone */ email: string", "@format"],
  ["/** @unique yes */ email: string", "@unique"],
])("malformed value %s", (declaration, tag) => {
  expect(failure(declaration)).toContain(tag);
});

test("unknown tags are rejected naming the tag", () => {
  const message = failure("/** @colour red */ name: string");
  expect(message).toContain("@colour");
  expect(message).toContain('"name"');
});

describe("@minItems and @maxItems", () => {
  test("are aliases on arrays", () => {
    expect(fieldOf("/** @minItems 1 @maxItems 3 */ tags: string[]")).toMatchObject({ minLength: 1, maxLength: 3 });
  });
  test("are rejected on strings", () => {
    expect(failure("/** @maxItems 3 */ name: string")).toContain("@maxItems");
  });
});
