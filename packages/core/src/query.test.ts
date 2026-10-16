import { describe, expect, test } from "bun:test";
import { HttpError } from "./errors.ts";
import { parseListQuery, type Condition } from "./query.ts";
import { entity, field } from "./testing/entities.ts";

const user = entity("User", [
  field({ name: "name", type: "string" }),
  field({ name: "age", type: "number", optional: true }),
  field({ name: "active", type: "boolean" }),
  field({ name: "birth", type: "date", optional: true }),
  field({ name: "role", type: "enum", values: ["admin", "member"] }),
  field({ name: "organization", type: "ref", target: "Organization", onDelete: "restrict", optional: true }),
  field({ name: "passwordHash", type: "string", hidden: true }),
  field({ name: "tags", type: "array", items: { type: "string" }, optional: true }),
]);

const parse = (query: string) => parseListQuery(user, new URLSearchParams(query));
const errorParams = (query: string) => {
  try {
    parse(query);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).code).toBe("VALIDATION_ERROR");
    return ((error as HttpError).details as { field: string }[]).map((detail) => detail.field);
  }
  throw new Error("expected the query to be rejected");
};

describe("operators on allowed types", () => {
  test.each([
    ["where[name][eq]=Jo", { field: "name", op: "eq", value: "Jo" }],
    ["where[name][ne]=Jo", { field: "name", op: "ne", value: "Jo" }],
    ["where[role][in]=admin,member", { field: "role", op: "in", value: ["admin", "member"] }],
    ["where[age][nin]=1,2", { field: "age", op: "nin", value: [1, 2] }],
    ["where[age][gt]=1", { field: "age", op: "gt", value: 1 }],
    ["where[age][gte]=18", { field: "age", op: "gte", value: 18 }],
    ["where[birth][lt]=2020-01-01", { field: "birth", op: "lt", value: new Date("2020-01-01") }],
    ["where[createdAt][lte]=2026-01-01T00:00:00Z", { field: "createdAt", op: "lte", value: new Date("2026-01-01T00:00:00Z") }],
    ["where[name][contains]=jo%", { field: "name", op: "contains", value: "jo%", caseInsensitive: true, literal: true }],
    ["where[name][startsWith]=J_", { field: "name", op: "startsWith", value: "J_", caseInsensitive: true, literal: true }],
    ["where[age][exists]=true", { field: "age", op: "exists", value: true }],
    ["where[organization][isNull]=false", { field: "organization", op: "isNull", value: false }],
    ["where[active][eq]=false", { field: "active", op: "eq", value: false }],
    ["where[id][eq]=abc", { field: "id", op: "eq", value: "abc" }],
  ])("%s", (query, condition) => {
    expect(parse(query).where).toEqual([condition as Condition]);
  });

  test("conditions are combined in order", () => {
    expect(parse("where[age][gte]=18&where[role][in]=admin,member").where).toHaveLength(2);
  });
});

test.each([
  "where[active][gt]=true",
  "where[name][gte]=a",
  "where[age][contains]=1",
  "where[role][startsWith]=a",
  "where[organization][lt]=x",
  "where[name][like]=a",
])("operator rejected on disallowed type: %s", (query) => {
  expect(errorParams(query)).toEqual([query.split("=")[0]!]);
});

describe("coercion", () => {
  test.each([
    "where[age][eq]=abc",
    "where[active][eq]=yes",
    "where[birth][eq]=yesterday",
    "where[role][eq]=root",
    "where[age][exists]=yes",
    "where[age][in]=1,x",
  ])("%s fails", (query) => {
    expect(errorParams(query)).toEqual([query.split("=")[0]!]);
  });
});

test("in accepts 100 values and rejects 101", () => {
  const values = (count: number) => Array.from({ length: count }, (_, index) => `v${index}`).join(",");
  expect(((parse(`where[name][in]=${values(100)}`).where[0] as { value: string[] }).value).length).toBe(100);
  expect(errorParams(`where[name][in]=${values(101)}`)).toEqual(["where[name][in]"]);
});

describe("sort", () => {
  test("defaults to createdAt desc with id tiebreaker", () => {
    expect(parse("").sort).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "id", direction: "desc" },
    ]);
  });
  test("parses directions and appends id", () => {
    expect(parse("sort=-age,name").sort).toEqual([
      { field: "age", direction: "desc" },
      { field: "name", direction: "asc" },
      { field: "id", direction: "desc" },
    ]);
  });
  test("keeps an explicit id", () => {
    expect(parse("sort=id").sort).toEqual([{ field: "id", direction: "asc" }]);
  });
  test("rejects unsortable fields", () => {
    expect(errorParams("sort=tags")).toEqual(["sort"]);
    expect(errorParams("sort=passwordHash")).toEqual(["sort"]);
  });
});

describe("pagination", () => {
  test("defaults", () => {
    expect(parse("")).toMatchObject({ limit: 20, offset: 0 });
  });
  test("bounds", () => {
    expect(parse("limit=1&offset=0")).toMatchObject({ limit: 1, offset: 0 });
    expect(parse("limit=100&offset=500")).toMatchObject({ limit: 100, offset: 500 });
  });
  test.each(["limit=101", "limit=0", "offset=-1", "limit=1.5", "limit=x"])("%s fails", (query) => {
    expect(errorParams(query)).toEqual([query.split("=")[0]!]);
  });
});

test.each([
  ["where[passwordHash][eq]=x", "where[passwordHash][eq]"],
  ["where[tags][eq]=a", "where[tags][eq]"],
  ["where[nope][eq]=a", "where[nope][eq]"],
  ["foo=bar", "foo"],
])("rejects %s", (query, param) => {
  expect(errorParams(query)).toEqual([param]);
});

test("duplicate field and operator are rejected", () => {
  expect(errorParams("where[age][gt]=1&where[age][gt]=2")).toEqual(["where[age][gt]"]);
});
