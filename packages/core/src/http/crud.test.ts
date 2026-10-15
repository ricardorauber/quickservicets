import { beforeEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "../adapters/memory.ts";
import type { Repositories } from "../hooks.ts";
import { createRepositories, type RepositoryRegistry } from "../repository.ts";
import { entity, field } from "../testing/entities.ts";
import { createCrudRoutes, mergeRoutes } from "./crud.ts";
import { createServer, type Route } from "./server.ts";

const user = entity("User", [
  field({ name: "email", type: "string", format: "email" }),
  field({ name: "name", type: "string", optional: true }),
]);
const audit = entity("AuditLog", [field({ name: "message", type: "string" })], {
  name: "audit-logs",
  repoKey: "auditLogs",
  tableName: "audit_logs",
  internal: true,
});

let repos: RepositoryRegistry;
beforeEach(async () => {
  const adapter = memoryAdapter();
  await adapter.connect([user, audit]);
  repos = createRepositories([user, audit], adapter);
});

const serverWith = (custom: Route[] = []) =>
  createServer({
    routes: mergeRoutes(createCrudRoutes([user, audit], repos), custom),
    repos: repos as unknown as Repositories,
    config: { production: true },
  });

const send = async (server: ReturnType<typeof serverWith>, method: string, path: string, body?: unknown) => {
  const response = await server.fetch(
    new Request(`http://localhost${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

test("one entity gets six routes", () => {
  expect(createCrudRoutes([user], repos).map((route) => `${route.method} ${route.path} ${route.operation}`)).toEqual([
    "GET /users list",
    "GET /users/[id] read",
    "POST /users create",
    "PATCH /users/[id] update",
    "PUT /users/[id] replace",
    "DELETE /users/[id] delete",
  ]);
});

test("each handler's status codes and bodies", async () => {
  const server = serverWith();
  const created = await send(server, "POST", "/users", { email: "a@b.co", name: "Ann" });
  expect(created.status).toBe(201);
  const id = created.body.id as string;

  expect(await send(server, "GET", `/users/${id}`)).toMatchObject({ status: 200, body: { id, email: "a@b.co" } });
  expect(await send(server, "PATCH", `/users/${id}`, { name: "Bea" })).toMatchObject({ status: 200, body: { name: "Bea" } });
  expect(await send(server, "PUT", `/users/${id}`, { email: "c@d.co" })).toMatchObject({
    status: 200,
    body: { email: "c@d.co", name: null },
  });
  expect(await send(server, "DELETE", `/users/${id}`)).toEqual({ status: 204, body: undefined });
  expect(await send(server, "GET", `/users/${id}`)).toEqual({
    status: 404,
    body: { error: { code: "NOT_FOUND", message: "User not found" } },
  });
});

test("repository errors pass through unchanged", async () => {
  const server = serverWith();
  const invalid = await send(server, "POST", "/users", { email: "nope", extra: 1 });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.details).toEqual([
    { field: "email", message: "Must be a valid email" },
    { field: "extra", message: "Unknown field" },
  ]);
  expect((await send(server, "DELETE", `/users/${Bun.randomUUIDv7()}`)).status).toBe(404);
});

describe("list", () => {
  test("shape and pagination", async () => {
    const server = serverWith();
    for (const email of ["a@b.co", "c@d.co", "e@f.co"]) await send(server, "POST", "/users", { email });
    const page = await send(server, "GET", "/users?limit=1");
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 3, limit: 1, offset: 0 });
    expect(page.body.data).toHaveLength(1);
  });
  test("invalid queries yield 400", async () => {
    expect((await send(serverWith(), "GET", "/users?limit=0")).status).toBe(400);
  });
});

test("custom routes with the same method and pattern replace generated ones", async () => {
  const server = serverWith([{ method: "GET", path: "/users/[userId]", handler: () => ({ custom: true }) }]);
  const created = await send(server, "POST", "/users", { email: "a@b.co" });
  expect(await send(server, "GET", `/users/${created.body.id}`)).toEqual({ status: 200, body: { custom: true } });
  expect((await send(server, "GET", "/users")).body.total).toBe(1);
  expect((await send(server, "PATCH", `/users/${created.body.id}`, { name: "x" })).status).toBe(200);
});

test("internal entities get no routes but stay in repos", async () => {
  const server = serverWith();
  expect(await send(server, "GET", "/audit-logs")).toEqual({
    status: 404,
    body: { error: { code: "NOT_FOUND", message: "Route not found" } },
  });
  expect(createCrudRoutes([audit], repos)).toEqual([]);
  expect(await repos.auditLogs!.create({ message: "hi" })).toMatchObject({ message: "hi" });
});
