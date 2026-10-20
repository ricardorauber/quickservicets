import { expect, test } from "bun:test";
import { memoryAdapter } from "../adapters/memory.ts";
import { definePostHook, type Repositories } from "../hooks.ts";
import { createRepositories, type Repository } from "../repository.ts";
import { entity, field } from "../testing/entities.ts";
import { createCrudRoutes } from "./crud.ts";
import { withHooks } from "./pipeline.ts";
import { populatedPrefixes, selectFields } from "./selection.ts";
import { createServer } from "./server.ts";

const user = entity("User", [
  field({ name: "name", type: "string" }),
  field({ name: "secret", type: "string", hidden: true }),
  field({ name: "address", type: "object", fields: [{ name: "city", type: "string", optional: false }] }),
  field({ name: "tags", type: "array", items: { type: "string" } }),
]);
user.exposure.read.exclude = ["secret"];

test("every prefix of a populate path counts as populated", () => {
  expect(populatedPrefixes(["organization.country"])).toEqual(["organization", "organization.country"]);
  expect(populatedPrefixes(["profiles.permissions.module", "profiles", "team"])).toEqual([
    "profiles",
    "profiles.permissions",
    "profiles.permissions.module",
    "team",
  ]);
  expect(populatedPrefixes([])).toEqual([]);
});

test("a record whose exposure keeps every field and that selects nothing comes back without copying", () => {
  const stored = { id: "1", createdAt: new Date(), updatedAt: new Date(), name: "Ann", address: { city: "Rio" }, tags: ["a"] };
  expect(selectFields(stored, user.exposure.read)).toBe(stored);
  expect(selectFields(stored, user.exposure.read, {})).toBe(stored);
  // A selection still builds a new object.
  expect(selectFields(stored, user.exposure.read, { fields: ["name"] })).toEqual({ name: "Ann" });
});

test("mutating a projected result does not change what another request reads", async () => {
  const adapter = memoryAdapter();
  await adapter.connect([user]);
  const repos = createRepositories([user], adapter);
  const users = repos.users as Repository;
  const scramble = definePostHook((result) => {
    const record = result as { name: string; address: { city: string }; tags: string[] };
    record.name = "changed";
    record.address.city = "changed";
    record.tags.push("changed");
    return record;
  });
  const routes = createCrudRoutes([user], repos).map((route) =>
    route.operation === "read" ? { ...route, handler: withHooks(route.handler, [{ name: "scramble", args: [] }], new Map([["scramble", scramble]])) } : route,
  );
  const server = createServer({ routes, repos: repos as unknown as Repositories, config: { production: true, logger: { info() {}, warn() {}, error() {} } } });
  const created = (await users.create({ name: "Ann", secret: "s", address: { city: "Rio" }, tags: ["a"] })) as { id: string };

  const first = await (await server.fetch(new Request(`http://localhost/users/${created.id}`))).json();
  expect(first).toMatchObject({ name: "changed", address: { city: "changed" }, tags: ["a", "changed"] });
  const listed = (await (await server.fetch(new Request("http://localhost/users"))).json()) as { data: unknown[] };
  expect(listed.data[0]).toMatchObject({ name: "Ann", address: { city: "Rio" }, tags: ["a"] });
  expect(listed.data[0]).not.toHaveProperty("secret");
  expect(await users.findById(created.id)).toMatchObject({ name: "Ann", address: { city: "Rio" }, tags: ["a"] });
});
