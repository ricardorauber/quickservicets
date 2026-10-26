import { describe, expect, test } from "bun:test";
import { createApp, memoryAdapter, resolveConfig, sqliteAdapter, type DatabaseAdapter } from "@quickservicets/core";
import { createSqliteTables } from "../../../core/src/testing/sql.ts";
import { parseEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";
import { generateTypesFile } from "./generate-types.ts";

const files = (organizationExtra = "") => ({
  "entities/Organization.ts": `import type { User } from "./User";\nimport type { Tag } from "./Tag";\nexport type Organization = { name: string; ${organizationExtra} users?: User[]; tags?: Tag[] }`,
  "entities/User.ts": 'import type { Organization } from "./Organization";\nexport type User = { name: string; organization?: Organization }',
  "entities/Tag.ts": 'import type { Organization } from "./Organization";\nexport type Tag = { label: string; organizations?: Organization[] }',
});

async function setup(factory: () => DatabaseAdapter = () => memoryAdapter(), extra = "") {
  const models = parseEntities(createProject(files(extra)));
  const base = factory();
  const calls: string[] = [];
  const adapter = {
    ...base,
    connect: base.connect.bind(base),
    findMany: (entity: never, options: never) => (calls.push((entity as { tableName: string }).tableName), base.findMany(entity, options)),
  } as DatabaseAdapter;
  const config = resolveConfig({ database: adapter, logger: { info() {}, warn() {}, error() {} } }, {});
  await config.database.connect(models);
  if (base.kind === "sqlite") await createSqliteTables((base as unknown as { client: never }).client, models);
  const crudRoutes = models
    .filter((model) => !model.internal)
    .flatMap((model) =>
      (["list", "read"] as const).map((operation) => ({
        method: "GET",
        path: operation === "list" ? `/${model.name}` : `/${model.name}/[id]`,
        entity: model.key,
        operation,
        hooks: [],
      })),
    );
  const { server, repos } = createApp({ models, crudRoutes, endpoints: [], hooks: new Map(), config });
  const repo = (name: string) => repos[name] as { create(d: unknown): Promise<{ id: string }> };
  const o1 = await repo("organizations").create({ name: "o1" });
  const o2 = await repo("organizations").create({ name: "o2" });
  const u1 = await repo("users").create({ name: "u1", organization: o1.id });
  const u2 = await repo("users").create({ name: "u2", organization: o1.id });
  await repo("users").create({ name: "u3", organization: o2.id });
  const t1 = await repo("tags").create({ label: "t1", organizations: [o1.id] });
  const get = async (path: string) => {
    const response = await server.fetch(new Request(`http://x${path}`));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const names = async (path: string) => ((await get(path)).body.data as { name: string }[]).map((item) => item.name).sort();
  return { get, names, calls, o1, o2, u1, u2, t1, models };
}

describe.each([
  ["memory", () => memoryAdapter()],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
] as const)("%s", (_, factory) => {
  test("derived sides appear as ids", async () => {
    const { get, o1, u1, u2, t1 } = await setup(factory);
    const { body } = await get(`/organizations/${o1.id}`);
    expect(body.users).toEqual([u1.id, u2.id]);
    expect(body.tags).toEqual([t1.id]);
  });

  test("derived arrays filter like reference arrays", async () => {
    const { names, u1, t1 } = await setup(factory);
    expect(await names(`/organizations?where[users][contains]=${u1.id}`)).toEqual(["o1"]);
    expect(await names("/organizations?where[users][size][gte]=2")).toEqual(["o1"]);
    expect(await names("/organizations?where[users][size][lt]=2")).toEqual(["o2"]);
    expect(await names(`/organizations?where[tags][containsAny]=${t1.id}`)).toEqual(["o1"]);
    expect(await names("/organizations?where[tags][isEmpty]=true")).toEqual(["o2"]);
  });

  test("populate and field selection reach derived sides", async () => {
    const { get, o1 } = await setup(factory);
    const { body } = await get(`/organizations/${o1.id}?populate=users&fields=name,users.name`);
    expect(body).toEqual({ name: "o1", users: [{ name: "u1" }, { name: "u2" }] });
  });
});

test("a derived single side filters like a reference", async () => {
  const models = parseEntities(
    createProject({
      "entities/Organization.ts": 'import type { User } from "./User";\nexport type Organization = { name: string; owner?: User }',
      "entities/User.ts": 'import type { Organization } from "./Organization";\nexport type User = { name: string; /** @owner */ organization?: Organization }',
    }),
  );
  const adapter = memoryAdapter();
  const config = resolveConfig({ database: adapter, logger: { info() {}, warn() {}, error() {} } }, {});
  await adapter.connect(models);
  const crudRoutes = [{ method: "GET", path: "/organizations", entity: "Organization", operation: "list" as const, hooks: [] }];
  const { server, repos } = createApp({ models, crudRoutes, endpoints: [], hooks: new Map(), config });
  const o1 = await (repos.organizations as { create(d: unknown): Promise<{ id: string }> }).create({ name: "o1" });
  await (repos.organizations as { create(d: unknown): Promise<{ id: string }> }).create({ name: "o2" });
  const user = await (repos.users as { create(d: unknown): Promise<{ id: string }> }).create({ name: "u", organization: o1.id });
  const names = async (query: string) =>
    (((await (await server.fetch(new Request(`http://x/organizations?${query}`))).json()) as { data: { name: string }[] }).data).map((item) => item.name).sort();
  expect(await names(`where[owner][eq]=${user.id}`)).toEqual(["o1"]);
  expect(await names("where[owner][isNull]=true")).toEqual(["o2"]);
  expect(await names("where[owner][exists]=true")).toEqual(["o1"]);
  expect((await server.fetch(new Request("http://x/organizations?sort=owner"))).status).toBe(400);
});

test("each derived field of a page loads with one batched query", async () => {
  const { get, calls } = await setup();
  calls.length = 0;
  await get("/organizations");
  expect(calls.filter((table) => table === "users")).toHaveLength(1);
  expect(calls.filter((table) => table === "organizations__tags" || table === "tags__organizations")).toHaveLength(1);
});

test("types do not distinguish derived from stored fields", () => {
  const types = generateTypesFile(parseEntities(createProject(files())));
  expect(types).toContain("  users: Array<string>;");
  expect(types).toContain("  organizations: Array<string>;");
  expect(types).not.toContain("Link");
});

describe("tags on derived sides", () => {
  test("@hidden:list applies", async () => {
    const hidden = parseEntities(
      createProject({
        ...files(),
        "entities/Organization.ts": 'import type { User } from "./User";\nimport type { Tag } from "./Tag";\nexport type Organization = { name: string; /** @hidden:list */ users?: User[]; tags?: Tag[] }',
      }),
    );
    expect(hidden.find((model) => model.entityName === "Organization")!.exposure.list.exclude).toEqual(["users"]);
  });
  test("@maxItems applies to derived writes", async () => {
    const models = parseEntities(
      createProject({
        ...files(),
        "entities/Organization.ts": 'import type { User } from "./User";\nimport type { Tag } from "./Tag";\nexport type Organization = { name: string; /** @maxItems 1 */ users?: User[]; tags?: Tag[] }',
      }),
    );
    expect(models.find((model) => model.entityName === "Organization")!.fields.find((field) => field.name === "users")).toMatchObject({ maxLength: 1 });
  });
  test("@unique on a derived side fails the build", () => {
    expect(() =>
      parseEntities(
        createProject({
          ...files(),
          "entities/Organization.ts": 'import type { User } from "./User";\nimport type { Tag } from "./Tag";\nexport type Organization = { name: string; /** @index */ owner?: User; tags?: Tag[] }',
          "entities/User.ts": 'import type { Organization } from "./Organization";\nexport type User = { name: string; /** @owner */ organization?: Organization }',
        }),
      ),
    ).toThrow("cannot use @unique or @index");
  });
});
