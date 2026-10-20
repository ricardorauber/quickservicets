import { describe, expect, test } from "bun:test";
import { parseFieldPaths, project } from "./projection.ts";
import { entity, field } from "./testing/entities.ts";

const user = entity("User", [
  field({ name: "name", type: "string" }),
  field({ name: "email", type: "string" }),
  field({ name: "role", type: "enum", values: ["a", "b"] }),
  field({ name: "organization", type: "ref", target: "Organization", onDelete: "restrict", optional: true }),
  field({ name: "tags", type: "array", items: { type: "string" } }),
  field({
    name: "address",
    type: "object",
    fields: [
      { name: "city", type: "string", optional: false },
      { name: "zip", type: "string", optional: true },
    ],
  }),
  field({
    name: "orders",
    type: "array",
    items: {
      type: "object",
      fields: [
        { name: "total", type: "number", optional: false },
        { name: "notes", type: "string", optional: true },
        { name: "lines", type: "array", optional: true, items: { type: "object", fields: [{ name: "qty", type: "number", optional: false }] } },
      ],
    },
  }),
]);

describe("path resolution", () => {
  test("through objects, arrays of objects and system fields", () => {
    expect(parseFieldPaths(user, "name, address.city ,name")).toEqual({ ok: true, paths: ["name", "address.city"] });
    expect(parseFieldPaths(user, ["orders.total", "orders.lines.qty", "id", "createdAt", "updatedAt"])).toMatchObject({ ok: true });
  });
  test.each(["email.domain", "tags.x", "role.x", "organization.name", "nope", "", "address.", "id.x"])("%p is invalid", (path) => {
    const result = parseFieldPaths(user, [path]);
    expect(result).toEqual({ ok: false, invalid: [path] });
  });
});

const record = {
  id: "1",
  name: "Ann",
  address: { city: "Rio", zip: "123" },
  orders: [
    { total: 1, notes: "a", lines: [{ qty: 1 }] },
    { total: 2, notes: "b", lines: [{ qty: 2 }] },
  ],
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("include", () => {
  test("whole subtrees", () => {
    expect(project(record, { include: ["address", "createdAt"] })).toEqual({ address: { city: "Rio", zip: "123" }, createdAt: record.createdAt });
  });
  test("partial nested objects", () => {
    expect(project(record, { include: ["address.city"] })).toEqual({ address: { city: "Rio" } });
  });
});

describe("exclude", () => {
  test("alone", () => {
    expect(project(record, { exclude: ["orders", "address.zip"] })).toEqual({
      id: "1",
      name: "Ann",
      address: { city: "Rio" },
      createdAt: record.createdAt,
    });
  });
  test("after include", () => {
    expect(project(record, { include: ["name", "address"], exclude: ["address.zip"] })).toEqual({ name: "Ann", address: { city: "Rio" } });
  });
});

test("paths through arrays apply to every item at any depth", () => {
  expect((project(record, { exclude: ["orders.notes"] }) as { orders: unknown }).orders).toEqual([
    { total: 1, lines: [{ qty: 1 }] },
    { total: 2, lines: [{ qty: 2 }] },
  ]);
  expect(project(record, { include: ["orders.lines.qty"] })).toEqual({ orders: [{ lines: [{ qty: 1 }] }, { lines: [{ qty: 2 }] }] });
});

test("null and missing values along a path are left as they are", () => {
  expect(project({ address: null }, { include: ["address.city"] })).toEqual({ address: null });
  expect(project({ name: "x" }, { include: ["address.city"] })).toEqual({});
  expect(project({ address: null }, { exclude: ["address.city"] })).toEqual({ address: null });
});

test("the input is never mutated", () => {
  const copy = structuredClone(record);
  project(record, { include: ["name"], exclude: ["name"] });
  project(record, { exclude: ["orders.notes", "address.zip"] });
  expect(record).toEqual(copy);
});

test("keep and remove build new objects only along the paths they change", () => {
  const kept = project(record, { include: ["name", "address", "orders.total"] }) as Record<string, unknown> & { address: unknown; orders: unknown[] };
  expect(kept).not.toBe(record);
  expect(kept.address).toBe(record.address);
  expect(kept.orders).not.toBe(record.orders);
  expect(kept.orders[0]).toEqual({ total: 1 });

  const removed = project(record, { exclude: ["address.zip"] }) as Record<string, unknown>;
  expect(removed).not.toBe(record);
  expect(removed.address).not.toBe(record.address);
  expect(removed.address).toEqual({ city: "Rio" });
  expect(removed.orders).toBe(record.orders);
  expect(removed.createdAt).toBe(record.createdAt);

  // Paths that are absent, or that keep every key in place, change nothing and copy nothing.
  expect(project(record, { exclude: ["email", "address.street", "orders.lines.price"] })).toBe(record);
  expect(project(record, { include: ["id", "name", "address", "orders", "createdAt"] })).toBe(record);
  // The kept order is the include order, as before.
  expect(Object.keys(project(record, { include: ["name", "id"] }) as object)).toEqual(["name", "id"]);
});
