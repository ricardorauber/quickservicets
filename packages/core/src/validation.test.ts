import { describe, expect, test } from "bun:test";
import { entity, field } from "./testing/entities.ts";
import { validateBody, type ValidationResult } from "./validation.ts";

const user = entity("User", [
  field({ name: "email", type: "string", format: "email" }),
  field({ name: "name", type: "string", minLength: 2, maxLength: 5 }),
  field({ name: "nickname", type: "string", optional: true }),
  field({ name: "role", type: "enum", values: ["admin", "member"], default: "member" }),
  field({ name: "age", type: "number", optional: true, min: 0, max: 120 }),
  field({ name: "active", type: "boolean", optional: true }),
  field({ name: "birth", type: "date", optional: true }),
  field({ name: "site", type: "string", optional: true, format: "url" }),
  field({ name: "organization", type: "ref", target: "Organization", onDelete: "restrict", optional: true }),
  field({ name: "tags", type: "array", items: { type: "string" }, optional: true, minLength: 1, maxLength: 2 }),
  field({
    name: "address",
    type: "object",
    optional: true,
    fields: [
      { name: "city", type: "string", optional: false },
      { name: "zip", type: "string", optional: true },
    ],
  }),
  field({
    name: "orders",
    type: "array",
    optional: true,
    items: { type: "object", fields: [{ name: "qty", type: "number", optional: false }] },
  }),
]);

const valid = { email: "a@b.co", name: "Jo" };
const details = (result: ValidationResult) => (result.ok ? [] : result.details);
const messageAt = (body: unknown, path: string, mode: "create" | "replace" | "patch" = "patch") =>
  details(validateBody(user, body, mode)).find((detail) => detail.field === path)?.message;

describe("modes", () => {
  test("create requires required fields without defaults", () => {
    expect(details(validateBody(user, {}, "create"))).toEqual([
      { field: "email", message: "Is required" },
      { field: "name", message: "Is required" },
    ]);
  });
  test("create accepts the minimal valid body", () => {
    expect(validateBody(user, valid, "create")).toEqual({ ok: true, value: valid });
  });
  test("replace requires every required field, even with a default", () => {
    expect(messageAt(valid, "role", "replace")).toBe("Is required");
  });
  test("patch ignores absent fields", () => {
    expect(validateBody(user, { name: "Jo" }, "patch")).toEqual({ ok: true, value: { name: "Jo" } });
  });
});

describe("type errors", () => {
  test.each([
    [{ email: 1 }, "email", "Must be a string"],
    [{ age: "1" }, "age", "Must be a number"],
    [{ active: "yes" }, "active", "Must be a boolean"],
    [{ birth: "yesterday" }, "birth", "Must be an ISO 8601 date"],
    [{ role: "root" }, "role", "Must be one of: admin, member"],
    [{ tags: "a" }, "tags", "Must be an array"],
    [{ address: "x" }, "address", "Must be an object"],
    [{ organization: "" }, "organization", "Must be a string"],
    [{ organization: 5 }, "organization", "Must be a string"],
  ])("%p", (body, path, message) => {
    expect(messageAt(body, path)).toBe(message);
  });

  test("numbers reject NaN and infinity", () => {
    expect(messageAt({ age: Number.NaN }, "age")).toBe("Must be a number");
    expect(messageAt(JSON.parse('{ "age": 1e999 }'), "age")).toBe("Must be a number");
  });
});

describe("tag errors with boundaries", () => {
  test.each([
    [{ name: "J" }, "name", "Must be at least 2 characters"],
    [{ name: "Johnny" }, "name", "Must be at most 5 characters"],
    [{ tags: [] }, "tags", "Must have at least 1 item"],
    [{ tags: ["a", "b", "c"] }, "tags", "Must have at most 2 items"],
    [{ age: -1 }, "age", "Must be at least 0"],
    [{ age: 121 }, "age", "Must be at most 120"],
  ])("%p", (body, path, message) => {
    expect(messageAt(body, path)).toBe(message);
  });

  test("exact boundaries pass", () => {
    expect(validateBody(user, { name: "Jo", age: 0, tags: ["a", "b"] }, "patch").ok).toBe(true);
    expect(validateBody(user, { name: "Johnn", age: 120, tags: ["a"] }, "patch").ok).toBe(true);
  });
});

describe("item counts", () => {
  const limited = (minLength: number, maxLength: number) =>
    entity("Team", [
      field({ name: "members", type: "refArray", target: "User", onDelete: "pull", minLength, maxLength }),
      field({ name: "labels", type: "array", items: { type: "string" }, minLength, maxLength }),
    ]);
  const messages = (minLength: number, maxLength: number, list: string[]) =>
    details(validateBody(limited(minLength, maxLength), { members: list, labels: list }, "patch")).map((detail) => detail.message);

  test("a count of 1 uses the singular", () => {
    expect(messages(1, 1, [])).toEqual(["Must have at least 1 item", "Must have at least 1 item"]);
    expect(messages(1, 1, ["a", "b"])).toEqual(["Must have at most 1 item", "Must have at most 1 item"]);
  });
  test("other counts use the plural", () => {
    expect(messages(2, 3, ["a"])).toEqual(["Must have at least 2 items", "Must have at least 2 items"]);
    expect(messages(0, 0, ["a"])).toEqual(["Must have at most 0 items", "Must have at most 0 items"]);
  });
});

describe("formats", () => {
  test.each(["a@b.co", "first.last@example.com.br"])("valid email %s", (email) => {
    expect(validateBody(user, { email }, "patch").ok).toBe(true);
  });
  test.each(["x", "a@b", "a b@c.d", "@b.co"])("invalid email %s", (email) => {
    expect(messageAt({ email }, "email")).toBe("Must be a valid email");
  });
  test.each(["https://example.com", "http://localhost:3000/a?b=1"])("valid url %s", (site) => {
    expect(validateBody(user, { site }, "patch").ok).toBe(true);
  });
  test.each(["example.com", "ftp://x.y", "not a url"])("invalid url %s", (site) => {
    expect(messageAt({ site }, "site")).toBe("Must be a valid URL");
  });
});

describe("null handling", () => {
  test("null clears optional fields in every mode", () => {
    expect(validateBody(user, { nickname: null }, "patch")).toEqual({ ok: true, value: { nickname: null } });
    expect(validateBody(user, { ...valid, nickname: null }, "create")).toEqual({ ok: true, value: { ...valid, nickname: null } });
  });
  test("null on required fields fails", () => {
    expect(messageAt({ name: null }, "name")).toBe("Cannot be null");
    expect(messageAt({ ...valid, name: null }, "name", "create")).toBe("Cannot be null");
  });
});

describe("nested paths", () => {
  test("arrays of primitives and objects", () => {
    expect(messageAt({ tags: ["a", 2] }, "tags[1]")).toBe("Must be a string");
    expect(messageAt({ orders: [{ qty: 1 }, { qty: "x" }] }, "orders[1].qty")).toBe("Must be a number");
    expect(messageAt({ orders: [{}] }, "orders[0].qty")).toBe("Is required");
  });
  test("objects", () => {
    expect(messageAt({ address: { city: 1 } }, "address.city")).toBe("Must be a string");
    expect(messageAt({ address: { city: "x", extra: 1 } }, "address.extra")).toBe("Unknown field");
  });
});

test("dates are converted to Date instances", () => {
  const result = validateBody(user, { birth: "2020-01-01T00:00:00Z" }, "patch");
  expect(result.ok && result.value.birth).toEqual(new Date("2020-01-01T00:00:00Z"));
});

test("system fields are read-only and the body must be an object", () => {
  expect(messageAt({ id: "abc" }, "id")).toBe("Field is read-only");
  expect(details(validateBody(user, [], "create"))).toEqual([{ field: "", message: "Body must be a JSON object" }]);
});

test("all errors are collected in a single result", () => {
  expect(details(validateBody(user, { email: "x", extra: 1 }, "create"))).toEqual([
    { field: "email", message: "Must be a valid email" },
    { field: "name", message: "Is required" },
    { field: "extra", message: "Unknown field" },
  ]);
});

describe("integer numbers", () => {
  const product = entity("Product", [
    field({ name: "stock", type: "number", integer: true, optional: true }),
    field({
      name: "dimensions",
      type: "object",
      optional: true,
      fields: [{ name: "units", type: "number", optional: true, integer: true }],
    }),
  ]);
  const errorsOf = (body: unknown) => details(validateBody(product, body, "patch"));

  test("whole numbers pass on top-level and nested fields", () => {
    expect(validateBody(product, { stock: 3, dimensions: { units: -2 } }, "patch")).toEqual({
      ok: true,
      value: { stock: 3, dimensions: { units: -2 } },
    });
  });

  test("fractions fail at the field", () => {
    expect(errorsOf({ stock: 1.5 })).toEqual([{ field: "stock", message: "Must be an integer" }]);
    expect(errorsOf({ dimensions: { units: 0.25 } })).toEqual([{ field: "dimensions.units", message: "Must be an integer" }]);
  });

  test("non-numbers keep the number error", () => {
    expect(errorsOf({ stock: "1" })).toEqual([{ field: "stock", message: "Must be a number" }]);
  });
});
