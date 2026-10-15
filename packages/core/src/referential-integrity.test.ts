import { describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { HttpError } from "./errors.ts";
import type { EntityModel, OnDeleteAction } from "./model.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";

const organization = entity("Organization", [field({ name: "name", type: "string" })]);
const userWith = (onDelete: OnDeleteAction) =>
  entity("User", [
    field({ name: "email", type: "string" }),
    field({ name: "organization", type: "ref", target: "Organization", onDelete, optional: true }),
  ]);

async function setup(models: EntityModel[]) {
  const adapter = memoryAdapter();
  await adapter.connect(models);
  return { adapter, repos: createRepositories(models, adapter) as Record<string, Repository> };
}

const httpError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected an HttpError");
};

describe("missing references", () => {
  test.each(["create", "update", "replace"] as const)("%s fails with 400 on the field", async (method) => {
    const { repos } = await setup([organization, userWith("restrict")]);
    const users = repos.users!;
    const body = { email: "a@b.co", organization: Bun.randomUUIDv7() };
    const call =
      method === "create" ? users.create(body) : users[method]((await users.create({ email: "a@b.co" })).id, body);
    const error = await httpError(call);
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ field: "organization", message: "Referenced record not found" }]);
  });

  test("existing references are accepted", async () => {
    const { repos } = await setup([organization, userWith("restrict")]);
    const org = await repos.organizations!.create({ name: "Acme" });
    expect(await repos.users!.create({ email: "a@b.co", organization: org.id })).toMatchObject({ organization: org.id });
  });
});

test("restrict blocks the delete with the referencing entity name", async () => {
  const { repos } = await setup([organization, userWith("restrict")]);
  const org = await repos.organizations!.create({ name: "Acme" });
  const user = await repos.users!.create({ email: "a@b.co", organization: org.id });
  const error = await httpError(repos.organizations!.delete(org.id));
  expect(error.status).toBe(409);
  expect(error.message).toBe("Cannot delete: referenced by users");
  expect(await repos.organizations!.findById(org.id)).not.toBeNull();
  expect(await repos.users!.findById(user.id)).not.toBeNull();
});

describe("cascade", () => {
  test("one level", async () => {
    const { repos } = await setup([organization, userWith("cascade")]);
    const org = await repos.organizations!.create({ name: "Acme" });
    const user = await repos.users!.create({ email: "a@b.co", organization: org.id });
    const other = await repos.users!.create({ email: "c@d.co" });
    await repos.organizations!.delete(org.id);
    expect(await repos.users!.findById(user.id)).toBeNull();
    expect(await repos.users!.findById(other.id)).not.toBeNull();
  });

  test("multiple levels", async () => {
    const post = entity("Post", [
      field({ name: "author", type: "ref", target: "User", onDelete: "cascade" }),
    ]);
    const { repos } = await setup([organization, userWith("cascade"), post]);
    const org = await repos.organizations!.create({ name: "Acme" });
    const user = await repos.users!.create({ email: "a@b.co", organization: org.id });
    const created = await repos.posts!.create({ author: user.id });
    await repos.organizations!.delete(org.id);
    expect(await repos.posts!.findById(created.id)).toBeNull();
  });
});

test("setNull clears the field and refreshes updatedAt", async () => {
  const { repos } = await setup([organization, userWith("setNull")]);
  const org = await repos.organizations!.create({ name: "Acme" });
  const user = await repos.users!.create({ email: "a@b.co", organization: org.id });
  await repos.organizations!.delete(org.id);
  const after = (await repos.users!.findById(user.id))!;
  expect(after.organization).toBeNull();
  expect(after.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
});

test("a deep restrict in a cascade chain blocks everything", async () => {
  const a = entity("A", [field({ name: "name", type: "string" })]);
  const b = entity("B", [field({ name: "a", type: "ref", target: "A", onDelete: "cascade" })]);
  const c = entity("C", [field({ name: "b", type: "ref", target: "B", onDelete: "restrict" })]);
  const { repos } = await setup([a, b, c]);
  const recordA = await repos.as!.create({ name: "x" });
  const recordB = await repos.bs!.create({ a: recordA.id });
  const recordC = await repos.cs!.create({ b: recordB.id });
  const error = await httpError(repos.as!.delete(recordA.id));
  expect(error.status).toBe(409);
  expect(error.message).toBe("Cannot delete: referenced by cs");
  expect(await repos.as!.findById(recordA.id)).not.toBeNull();
  expect(await repos.bs!.findById(recordB.id)).not.toBeNull();
  expect(await repos.cs!.findById(recordC.id)).not.toBeNull();
});

test("self-referencing cascade removes the subtree and terminates", async () => {
  const category = entity(
    "Category",
    [
      field({ name: "name", type: "string" }),
      field({ name: "parent", type: "ref", target: "Category", onDelete: "cascade", optional: true }),
    ],
    { name: "categories", repoKey: "categories", tableName: "categories" },
  );
  const { repos } = await setup([category]);
  const categories = repos.categories!;
  const root = await categories.create({ name: "root" });
  const child = await categories.create({ name: "child", parent: root.id });
  const grandchild = await categories.create({ name: "grandchild", parent: child.id });
  const unrelated = await categories.create({ name: "other" });
  await categories.delete(root.id);
  for (const record of [root, child, grandchild]) expect(await categories.findById(record.id)).toBeNull();
  expect(await categories.findById(unrelated.id)).not.toBeNull();
});
