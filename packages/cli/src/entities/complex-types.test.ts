import { describe, expect, test } from "bun:test";
import { createProject } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

const fieldsOf = (body: string) =>
  parseEntities(createProject({ "entities/Item.ts": `export type Item = ${body}` }))[0]!.fields;

const failure = (body: string) => {
  try {
    fieldsOf(body);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};

test("enums keep declaration order", () => {
  expect(fieldsOf("{ role: 'member' | 'admin' | 'owner' }")[0]).toEqual({
    name: "role",
    type: "enum",
    values: ["member", "admin", "owner"],
    optional: false,
    storage: "column",
  });
});

describe("invalid unions", () => {
  test.each(["'a' | 1", "1 | 2", "string | null", "'a' | string"])("%s is rejected naming file and field", (type) => {
    const message = failure(`{ status: ${type} }`);
    expect(message).toContain("entities/Item.ts");
    expect(message).toContain('"status"');
  });
});

test("both array syntaxes", () => {
  const [tags, scores] = fieldsOf("{ tags: string[]; scores: Array<number> }");
  expect(tags).toMatchObject({ type: "array", items: { type: "string" } });
  expect(scores).toMatchObject({ type: "array", items: { type: "number" } });
});

test("optional fields inside nested objects", () => {
  expect(fieldsOf("{ address: { city: string; zip?: string } }")[0]).toEqual({
    name: "address",
    type: "object",
    fields: [
      { name: "city", type: "string", optional: false },
      { name: "zip", type: "string", optional: true },
    ],
    optional: false,
    storage: "json",
  });
});

test("deep nesting", () => {
  expect(fieldsOf("{ orders: { lines: { qty: number }[] }[] }")[0]).toEqual({
    name: "orders",
    type: "array",
    items: {
      type: "object",
      fields: [
        {
          name: "lines",
          type: "array",
          items: { type: "object", fields: [{ name: "qty", type: "number", optional: false }] },
          optional: false,
        },
      ],
    },
    optional: false,
    storage: "json",
  });
});

test("nested unsupported types name the nested path", () => {
  expect(failure("{ address: { geo: bigint } }")).toContain('"address.geo"');
});

test("storage classification for every field kind", () => {
  const fields = fieldsOf(
    "{ s: string; n: number; b: boolean; d: Date; e: 'x' | 'y'; a: string[]; o: { k: string } }",
  );
  expect(Object.fromEntries(fields.map((field) => [field.name, field.storage]))).toEqual({
    s: "column",
    n: "column",
    b: "column",
    d: "column",
    e: "column",
    a: "json",
    o: "json",
  });
});
