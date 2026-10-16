import { describe, expect, test } from "bun:test";
import { HttpError } from "./errors.ts";
import { parseListQuery } from "./query.ts";
import { entity, field } from "./testing/entities.ts";

const organization = entity("Organization", [
  field({ name: "name", type: "string" }),
  field({ name: "members", type: "refArray", target: "User", onDelete: "pull", optional: true }),
]);
const parse = (query: string, model = organization) => parseListQuery(model, new URLSearchParams(query));
const rejected = (query: string, model = organization) => {
  try {
    parse(query, model);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    return ((error as HttpError).details as { field: string }[]).map((detail) => detail.field);
  }
  throw new Error("expected 400");
};

describe("accepted operators", () => {
  test.each([
    ["where[members][contains]=a", { field: "members", op: "contains", value: "a" }],
    ["where[members][containsAny]=a,b", { field: "members", op: "containsAny", value: ["a", "b"] }],
    ["where[members][containsAll]=a,b,a", { field: "members", op: "containsAll", value: ["a", "b"] }],
    ["where[members][size][gte]=3", { field: "members", op: "size", value: { compare: "gte", count: 3 } }],
    ["where[members][size][eq]=0", { field: "members", op: "size", value: { compare: "eq", count: 0 } }],
    ["where[members][isEmpty]=true", { field: "members", op: "isEmpty", value: true }],
  ])("%s", (query, condition) => {
    expect(parse(query).where).toEqual([condition as never]);
  });
});

describe("rejections", () => {
  test.each([
    "where[members][gt]=1",
    "where[members][eq]=a",
    "where[members][size]=1",
    "where[members][size][like]=1",
    "where[members][size][gt]=-1",
    "where[members][size][gt]=x",
    "where[members][isEmpty]=yes",
    "where[members][containsAny]=",
    "where[name][containsAny]=a",
    "where[name][size][eq]=1",
  ])("%s", (query) => {
    expect(rejected(query)).toEqual([query.split("=")[0]!]);
  });
  test("reference arrays cannot be sorted", () => {
    expect(rejected("sort=members")).toEqual(["sort"]);
  });
  test("at most 100 ids", () => {
    const ids = Array.from({ length: 101 }, (_, index) => `id${index}`).join(",");
    expect(rejected(`where[members][containsAny]=${ids}`)).toEqual(["where[members][containsAny]"]);
  });
  test("arrays not exposed on list cannot be filtered", () => {
    const hidden = entity("Organization", organization.fields, {
      exposure: { list: { include: ["id", "name"], exclude: [] }, read: organization.exposure.read },
    });
    expect(rejected("where[members][contains]=a", hidden)).toEqual(["where[members][contains]"]);
  });
});
