import { beforeEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { HttpError } from "./errors.ts";
import { parseListQuery } from "./query.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";

const user = entity("User", [
  field({ name: "email", type: "string", format: "email", unique: true }),
  field({ name: "name", type: "string", optional: true }),
  field({ name: "role", type: "enum", values: ["admin", "member"], default: "member" }),
  field({ name: "tags", type: "array", items: { type: "string" }, default: [] }),
  field({ name: "passwordHash", type: "string", hidden: true, optional: true }),
]);

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let users: Repository;
beforeEach(async () => {
  const adapter = memoryAdapter();
  await adapter.connect([user]);
  users = createRepositories([user], adapter).users as Repository;
});

const httpError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected an HttpError");
};

test("ids are UUID v7 and increase across sequential creates", async () => {
  const first = await users.create({ email: "a@b.co" });
  const second = await users.create({ email: "c@d.co" });
  expect(first.id).toMatch(UUID_V7);
  expect(second.id).toMatch(UUID_V7);
  expect(second.id > first.id).toBe(true);
});

describe("defaults", () => {
  test("applied when the field is absent", async () => {
    expect(await users.create({ email: "a@b.co" })).toMatchObject({ role: "member", tags: [] });
  });
  test("not applied when the field is present", async () => {
    expect(await users.create({ email: "a@b.co", role: "admin", tags: ["x"] })).toMatchObject({ role: "admin", tags: ["x"] });
  });
});

describe("timestamps", () => {
  test("create sets equal createdAt and updatedAt", async () => {
    const created = await users.create({ email: "a@b.co" });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toEqual(created.createdAt);
  });
  test("update refreshes updatedAt and changes only given fields", async () => {
    const created = await users.create({ email: "a@b.co", name: "Ann" });
    const updated = await users.update(created.id, { role: "admin" });
    expect(updated).toMatchObject({ email: "a@b.co", name: "Ann", role: "admin" });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.createdAt.getTime());
    expect(updated.createdAt).toEqual(created.createdAt);
  });
  test("replace keeps id and createdAt and clears omitted optional fields", async () => {
    const created = await users.create({ email: "a@b.co", name: "Ann" });
    const replaced = await users.replace(created.id, { email: "x@y.co", role: "member", tags: [] });
    expect(replaced).toMatchObject({ id: created.id, email: "x@y.co", name: null });
    expect(replaced.createdAt).toEqual(created.createdAt);
    expect(replaced.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });
});

test("validation errors become 400 Invalid body with details", async () => {
  const error = await httpError(users.create({}));
  expect(error.status).toBe(400);
  expect(error.message).toBe("Invalid body");
  expect(error.details).toEqual([{ field: "email", message: "Is required" }]);
  expect((await httpError(users.update(Bun.randomUUIDv7(), { role: "x" }))).status).toBe(400);
});

describe("not found", () => {
  const missing = Bun.randomUUIDv7();
  test("reads return null", async () => {
    expect(await users.findById(missing)).toBeNull();
    expect(await users.findOne([{ field: "email", op: "eq", value: "none" }])).toBeNull();
  });
  test.each(["update", "replace", "delete"] as const)("%s throws 404 User not found", async (method) => {
    const call =
      method === "delete" ? users.delete(missing) : users[method](missing, { email: "a@b.co", role: "member", tags: [] });
    const error = await httpError(call);
    expect(error.status).toBe(404);
    expect(error.message).toBe("User not found");
  });
  test("delete returns nothing on success", async () => {
    const created = await users.create({ email: "a@b.co" });
    expect(await users.delete(created.id)).toBeUndefined();
    expect(await users.findById(created.id)).toBeNull();
  });
});

test("hidden fields are stripped unless includeHidden is set", async () => {
  const created = await users.create({ email: "a@b.co", passwordHash: "secret" });
  expect(created).not.toHaveProperty("passwordHash");
  expect(await users.findById(created.id)).not.toHaveProperty("passwordHash");
  const listed = await users.list(parseListQuery(user, new URLSearchParams()));
  expect(listed.data[0]).not.toHaveProperty("passwordHash");
  const found = await users.findOne([{ field: "email", op: "eq", value: "a@b.co" }], { includeHidden: true });
  expect(found).toMatchObject({ passwordHash: "secret" });
  expect(await users.update(created.id, { name: "A" })).not.toHaveProperty("passwordHash");
});

test("list returns data, total, limit and offset", async () => {
  for (const email of ["a@b.co", "c@d.co", "e@f.co"]) await users.create({ email });
  const result = await users.list(parseListQuery(user, new URLSearchParams("limit=2&offset=1")));
  expect(result.total).toBe(3);
  expect(result.data).toHaveLength(2);
  expect(result).toMatchObject({ limit: 2, offset: 1 });
});

test("unique violations become 409 Value already exists", async () => {
  await users.create({ email: "a@b.co" });
  const error = await httpError(users.create({ email: "a@b.co" }));
  expect(error.status).toBe(409);
  expect(error.code).toBe("CONFLICT");
  expect(error.message).toBe("Value already exists");
  expect(error.details).toEqual([{ field: "email", message: "Value already exists" }]);
});
