import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp, memoryAdapter, resolveConfig, type DatabaseAdapter } from "@quickservicets/core";
import { parseEntities } from "../entities/parse-entities.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

const entities = (userDoc = "", organizationExtra = "") => ({
  "entities/Country.ts": "export type Country = { name: string; code: string }",
  "entities/Organization.ts": `import type { Country } from "./Country";\nexport type Organization = { name: string; country?: Country; /** @hidden:read */ secret?: string; ${organizationExtra} }`,
  "entities/User.ts": `import type { Organization } from "./Organization";\n${userDoc}\nexport type User = { name: string; organization?: Organization }`,
});

function counting(adapter: DatabaseAdapter) {
  const calls: string[] = [];
  return {
    calls,
    adapter: { ...adapter, findMany: (entity: never, options: never) => (calls.push((entity as { tableName: string }).tableName), adapter.findMany(entity, options)) } as DatabaseAdapter,
  };
}

async function setup(userDoc = "") {
  const models = parseEntities(createProject(entities(userDoc)));
  const base = memoryAdapter();
  const { adapter, calls } = counting(base);
  const config = resolveConfig({ database: adapter, logger: { info() {}, warn() {}, error() {} } }, {});
  await config.database.connect(models);
  const crudRoutes = models.flatMap((model) =>
    (["list", "read"] as const).map((operation) => ({
      method: "GET",
      path: operation === "list" ? `/${model.name}` : `/${model.name}/[id]`,
      entity: model.key,
      operation,
      hooks: [],
    })),
  );
  const { server, repos } = createApp({ models, crudRoutes, endpoints: [], hooks: new Map(), config });
  const create = (repo: string, data: unknown) => (repos[repo] as { create(data: unknown): Promise<{ id: string }> }).create(data);
  const country = await create("countries", { name: "Brazil", code: "BR" });
  const organization = await create("organizations", { name: "Acme", country: country.id, secret: "s" });
  const user = await create("users", { name: "Ann", organization: organization.id });
  const get = async (path: string) => {
    const response = await server.fetch(new Request(`http://x${path}`));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { get, user, organization, country, calls, base, models };
}

test("read populates on request and keeps ids otherwise", async () => {
  const { get, user, organization } = await setup();
  expect((await get(`/users/${user.id}`)).body.organization).toBe(organization.id);
  expect((await get(`/users/${user.id}?populate=organization`)).body.organization).toMatchObject({ id: organization.id, name: "Acme" });
});

describe("paths", () => {
  test("two levels on list", async () => {
    const { get } = await setup();
    const body = (await get("/users?populate=organization.country")).body;
    expect(body.data[0].organization.country).toMatchObject({ name: "Brazil" });
  });
  test("deeper than the limit fails", async () => {
    const { get } = await setup();
    const response = await get("/users?populate=organization.country.name");
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Populate depth exceeds 2");
  });
  test("non-reference segments fail", async () => {
    const { get } = await setup();
    const response = await get("/users?populate=name");
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Cannot populate: name");
  });
});

test("the entity tag populates by default and the query adds to it", async () => {
  const { get, user } = await setup("/** @populate:read organization */");
  expect(typeof (await get(`/users/${user.id}`)).body.organization).toBe("object");
  expect(typeof (await get("/users")).body.data[0].organization).toBe("string");
  expect((await get(`/users/${user.id}?populate=organization.country`)).body.organization.country).toMatchObject({ code: "BR" });
});

test("populated records follow the target's read exposure and hidden rules", async () => {
  const { get, user } = await setup();
  expect((await get(`/users/${user.id}?populate=organization`)).body.organization).not.toHaveProperty("secret");
});

describe("field selection inside populated references", () => {
  test("allowed when populated", async () => {
    const { get, user } = await setup();
    expect((await get(`/users/${user.id}?populate=organization&fields=name,organization.name`)).body).toEqual({
      name: "Ann",
      organization: { name: "Acme" },
    });
  });
  test("unknown when not populated", async () => {
    const { get, user } = await setup();
    const response = await get(`/users/${user.id}?fields=name,organization.name`);
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([{ field: "fields", message: "Unknown field: organization.name" }]);
  });
});

describe("field selection under nested populate paths", () => {
  test("fields reach every level of a nested path on list and read", async () => {
    const { get, user } = await setup();
    const list = await get("/users?populate=organization.country&fields=organization.name");
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([{ organization: { name: "Acme" } }]);
    const read = await get(`/users/${user.id}?populate=organization.country&fields=name,organization.name,organization.country.code`);
    expect(read.body).toEqual({ name: "Ann", organization: { name: "Acme", country: { code: "BR" } } });
  });

  test("fields under a nested path of reference arrays", async () => {
    const models = parseEntities(
      createProject({
        "entities/Module.ts": "export type Module = { key: string }",
        "entities/Permission.ts": 'import type { Module } from "./Module";\nexport type Permission = { action: string; module: Module }',
        "entities/Profile.ts": 'import type { Permission } from "./Permission";\nexport type Profile = { slug: string; label: string; permissions: Permission[] }',
        "entities/Membership.ts": 'import type { Profile } from "./Profile";\nexport type Membership = { role: string; profiles: Profile[] }',
      }),
    );
    const config = resolveConfig({ database: memoryAdapter(), populate: { maxDepth: 3 }, logger: { info() {}, warn() {}, error() {} } }, {});
    await config.database.connect(models);
    const crudRoutes = models.map((model) => ({ method: "GET", path: `/${model.name}`, entity: model.key, operation: "list" as const, hooks: [] }));
    const { server, repos } = createApp({ models, crudRoutes, endpoints: [], hooks: new Map(), config });
    const create = (repo: string, data: unknown) => (repos[repo] as { create(data: unknown): Promise<{ id: string }> }).create(data);
    const module = await create("modules", { key: "billing" });
    const permission = await create("permissions", { action: "read", module: module.id });
    const admin = await create("profiles", { slug: "admin", label: "Admin", permissions: [permission.id] });
    const viewer = await create("profiles", { slug: "viewer", label: "Viewer", permissions: [] });
    await create("memberships", { role: "owner", profiles: [admin.id, viewer.id] });
    const response = await server.fetch(new Request("http://x/memberships?populate=profiles.permissions.module&fields=profiles.slug"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data).toEqual([{ profiles: [{ slug: "admin" }, { slug: "viewer" }] }]);
  });

  test("exclude under a populated prefix removes the path", async () => {
    const { get, user } = await setup();
    const list = await get("/users?populate=organization.country&exclude=organization.country");
    expect(list.status).toBe(200);
    expect(list.body.data[0].organization).toMatchObject({ name: "Acme" });
    expect(list.body.data[0].organization).not.toHaveProperty("country");
    const read = await get(`/users/${user.id}?populate=organization.country&exclude=organization.country.code`);
    expect(read.body.organization.country).toMatchObject({ name: "Brazil" });
    expect(read.body.organization.country).not.toHaveProperty("code");
  });

  test("unknown paths under a populated prefix are still rejected", async () => {
    const { get, user } = await setup();
    for (const path of ["/users?populate=organization.country&fields=organization.nope", `/users/${user.id}?populate=organization.country&exclude=organization.nope`]) {
      const response = await get(path);
      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe("Invalid query");
      expect(response.body.error.details).toEqual([{ field: path.includes("exclude") ? "exclude" : "fields", message: "Unknown field: organization.nope" }]);
    }
    const hidden = await get("/users?populate=organization.country&fields=organization.secret");
    expect(hidden.body.error.details).toEqual([{ field: "fields", message: "Unknown field: organization.secret" }]);
  });
});

test("each reference path is loaded with one batched query", async () => {
  const { get, calls } = await setup();
  calls.length = 0;
  await get("/users?populate=organization.country");
  expect(calls.filter((table) => table === "organizations")).toHaveLength(1);
  expect(calls.filter((table) => table === "countries")).toHaveLength(1);
});

test("a deleted referenced record becomes null", async () => {
  const { get, user, organization, base, models } = await setup();
  await base.deleteById(models.find((model) => model.entityName === "Organization")!, organization.id);
  expect((await get(`/users/${user.id}?populate=organization`)).body.organization).toBeNull();
});

describe("endpoint @populate", () => {
  async function built(files: Record<string, string>) {
    const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, ...entities(), ...files });
    await build(root);
    return root;
  }
  test("on an override it replaces the entity tag", async () => {
    const root = await built({
      "endpoints/users/[id]/get.ts": '/** @populate organization */\nexport default async (repos, req) => repos.users.findById(req.params.id);',
    });
    const { models } = await import(join(root, ".generated/models.ts"));
    const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
    const config = resolveConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} } }, {});
    await config.database.connect(models);
    const { server, repos } = createApp({ models, crudRoutes, endpoints, hooks, config });
    const organization = await (repos.organizations as { create(d: unknown): Promise<{ id: string }> }).create({ name: "Acme" });
    const user = await (repos.users as { create(d: unknown): Promise<{ id: string }> }).create({ name: "Ann", organization: organization.id });
    const body = (await (await server.fetch(new Request(`http://x/users/${user.id}`))).json()) as Record<string, any>;
    expect(body.organization).toMatchObject({ name: "Acme" });
  });
  test("elsewhere it fails the build naming the file", async () => {
    await expect(built({ "endpoints/reports/get.ts": "/** @populate organization */\nexport default () => [];" })).rejects.toThrow(
      "endpoints/reports/get.ts",
    );
  });
  test("tag paths beyond the depth fail the build", async () => {
    await expect(built({ "endpoints/users/get.ts": "/** @populate organization.country.name */\nexport default () => [];" })).rejects.toThrow(
      "Populate depth exceeds 2",
    );
  });
});

test("generated types map references for populated reads", async () => {
  const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, ...entities() });
  await build(root);
  const types = await Bun.file(join(root, ".generated/types.ts")).text();
  expect(types).toContain("users: Repository<User, UserReferences, UserCreate, UserUpdate>;");
  expect(types).toContain("export type UserReferences = {\n  organization: One<Organization, OrganizationReferences>;\n};");
  expect(types).toContain("countries: Repository<Country, CountryReferences, CountryCreate, CountryUpdate>;");
});
