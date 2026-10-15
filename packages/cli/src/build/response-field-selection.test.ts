import { describe, expect, test } from "bun:test";
import { createApp, definePostHook, memoryAdapter, resolveConfig } from "@quickservice/core";
import { parseEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

async function serverFor(userSource: string, readHook = false) {
  const models = parseEntities(createProject({ "entities/User.ts": userSource }));
  const config = resolveConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} } }, {});
  await config.database.connect(models);
  const seen: unknown[] = [];
  const hooks = new Map([["spy", definePostHook((data) => (seen.push(structuredClone(data)), data))]]);
  const crudRoutes = [
    { method: "GET", path: "/users", entity: "User", operation: "list" as const, hooks: [] },
    { method: "GET", path: "/users/[id]", entity: "User", operation: "read" as const, hooks: readHook ? [{ name: "spy", args: [] }] : [] },
  ];
  const { server } = createApp({ models, crudRoutes, endpoints: [], hooks, config });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const created = await call("POST", "/users", { email: "a@b.co", name: "Ann", address: { city: "Rio", zip: "123" } });
  return { call, id: created.body.id as string, seen };
}

const user = `export type User = {
  email: string;
  name: string;
  /** @hidden:list */ address: { city: string; zip: string };
};`;

describe("exposed paths", () => {
  test("list hides what the entity hides on list; read keeps it", async () => {
    const { call, id } = await serverFor(user);
    const list = await call("GET", "/users");
    expect((list.body.data as Record<string, unknown>[])[0]).not.toHaveProperty("address");
    expect((await call("GET", `/users/${id}`)).body).toMatchObject({ address: { city: "Rio", zip: "123" } });
  });
  test("an entity whitelist applies to list items", async () => {
    const { call } = await serverFor(`/** @fields:list name */\n${user}`);
    expect((await call("GET", "/users")).body.data).toEqual([{ name: "Ann" }]);
  });
});

describe("client selection", () => {
  test("fields keeps only the selected paths, without id", async () => {
    const { call, id } = await serverFor(user);
    expect((await call("GET", `/users/${id}?fields=name,address.city`)).body).toEqual({ name: "Ann", address: { city: "Rio" } });
  });
  test("fields then exclude", async () => {
    const { call, id } = await serverFor(user);
    expect((await call("GET", `/users/${id}?fields=name,address&exclude=address.zip`)).body).toEqual({ name: "Ann", address: { city: "Rio" } });
  });
  test("exclude alone", async () => {
    const { call } = await serverFor(user);
    const item = ((await call("GET", "/users?exclude=email")).body.data as Record<string, unknown>[])[0]!;
    expect(item).not.toHaveProperty("email");
    expect(item).toHaveProperty("name");
  });
});

describe("validation", () => {
  test.each([
    ["/users?fields=address", { field: "fields", message: "Unknown field: address" }],
    ["/users?fields=nope", { field: "fields", message: "Unknown field: nope" }],
    ["/users?fields=name&exclude=email", { field: "exclude", message: "Field is not selected: email" }],
    ["/users?fields=", { field: "fields", message: "Must list at least one field" }],
    ["/users?exclude=", { field: "exclude", message: "Must list at least one field" }],
  ])("%s", async (path, detail) => {
    const { call } = await serverFor(user);
    const response = await call("GET", path);
    expect(response.status).toBe(400);
    expect((response.body.error as { details: unknown[] }).details).toEqual([detail]);
  });

  test("always-hidden fields are unknown to the client", async () => {
    const { call, id } = await serverFor("export type User = { email: string; /** @hidden */ passwordHash?: string; name?: string; address?: { city: string; zip: string } };");
    expect((await call("GET", `/users/${id}?fields=passwordHash`)).status).toBe(400);
  });
});

describe("filters and sorts", () => {
  test("only accept fields exposed on list", async () => {
    const { call } = await serverFor("export type User = { /** @hidden:list */ email: string; name: string; address: { city: string; zip: string } };");
    expect((await call("GET", "/users?where[email][eq]=a@b.co")).status).toBe(400);
    expect((await call("GET", "/users?sort=email")).status).toBe(400);
    expect((await call("GET", "/users?where[name][eq]=Ann")).status).toBe(200);
  });
  test("client selection does not restrict filters", async () => {
    const { call } = await serverFor(user);
    const response = await call("GET", "/users?fields=name&where[email][eq]=a@b.co");
    expect(response.body).toMatchObject({ total: 1, data: [{ name: "Ann" }] });
  });
});

test("post-hooks receive the projected data", async () => {
  const { call, id, seen } = await serverFor(user, true);
  await call("GET", `/users/${id}?fields=name`);
  expect(seen).toEqual([{ name: "Ann" }]);
});
