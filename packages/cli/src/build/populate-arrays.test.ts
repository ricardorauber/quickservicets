import { expect, test } from "bun:test";
import { createApp, memoryAdapter, resolveConfig, type DatabaseAdapter } from "@quickservice/core";
import { parseEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";
import { generateTypesFile } from "./generate-types.ts";

const files = {
  "entities/Team.ts": "export type Team = { label: string; /** @hidden */ code?: string }",
  "entities/User.ts": 'import type { Team } from "./Team";\nexport type User = { name: string; /** @hidden:read */ email?: string; team?: Team }',
  "entities/Organization.ts": 'import type { User } from "./User";\nexport type Organization = { name: string; members?: User[] }',
};

async function setup() {
  const models = parseEntities(createProject(files));
  const base = memoryAdapter();
  const calls: string[] = [];
  const adapter = {
    ...base,
    findMany: (entity: never, options: never) => (calls.push((entity as { tableName: string }).tableName), base.findMany(entity, options)),
  } as DatabaseAdapter;
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
  const create = (repo: string, data: unknown) => (repos[repo] as { create(d: unknown): Promise<{ id: string }> }).create(data);
  const team = await create("teams", { label: "core", code: "secret" });
  const [ann, bob, cid] = [
    await create("users", { name: "Ann", email: "a@x.co", team: team.id }),
    await create("users", { name: "Bob", team: team.id }),
    await create("users", { name: "Cid" }),
  ];
  const organizations: { id: string }[] = [];
  for (let index = 0; index < 20; index++) {
    organizations.push(await create("organizations", { name: `o${index}`, members: [cid!.id, ann!.id, bob!.id] }));
  }
  const get = async (path: string) => {
    const response = await server.fetch(new Request(`http://x${path}`));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { get, calls, base, models, organization: organizations[0]!, ann: ann!, bob: bob!, cid: cid! };
}

test("populated arrays keep the stored order", async () => {
  const { get, organization } = await setup();
  const { body } = await get(`/organizations/${organization.id}?populate=members`);
  expect(body.members.map((member: { name: string }) => member.name)).toEqual(["Cid", "Ann", "Bob"]);
});

test("records that no longer exist are omitted, not null", async () => {
  const { get, organization, base, models, bob } = await setup();
  await base.deleteById(models.find((model) => model.entityName === "User")!, bob.id);
  const { body } = await get(`/organizations/${organization.id}?populate=members`);
  expect(body.members.map((member: { name: string }) => member.name)).toEqual(["Cid", "Ann"]);
});

test("one batched query per array path, for every owner and item", async () => {
  const { get, calls } = await setup();
  calls.length = 0;
  const { body } = await get("/organizations?populate=members.team");
  expect(body.data).toHaveLength(20);
  expect(calls.filter((table) => table === "users")).toHaveLength(1);
  expect(calls.filter((table) => table === "teams")).toHaveLength(1);
});

test("items follow the target's read exposure and hidden rules", async () => {
  const { get, organization } = await setup();
  const { body } = await get(`/organizations/${organization.id}?populate=members.team`);
  const ann = body.members[1];
  expect(ann).not.toHaveProperty("email");
  expect(ann.team).toMatchObject({ label: "core" });
  expect(ann.team).not.toHaveProperty("code");
});

test("field selection reaches into populated arrays", async () => {
  const { get, organization } = await setup();
  const populated = await get(`/organizations/${organization.id}?populate=members&fields=name,members.name`);
  expect(populated.body).toEqual({ name: "o0", members: [{ name: "Cid" }, { name: "Ann" }, { name: "Bob" }] });
  const unpopulated = await get(`/organizations/${organization.id}?fields=name,members.name`);
  expect(unpopulated.status).toBe(400);
});

test("array segments count towards the depth limit", async () => {
  const { get } = await setup();
  expect((await get("/organizations?populate=members.team")).status).toBe(200);
  const tooDeep = await get("/organizations?populate=members.team.label");
  expect(tooDeep.status).toBe(400);
  expect(tooDeep.body.error.message).toBe("Populate depth exceeds 2");
});

test("generated types type populated arrays as record arrays", () => {
  const types = generateTypesFile(parseEntities(createProject(files)));
  expect(types).toContain("organizations: Repository<Organization, { members: Array<User> }>;");
  expect(types).toContain("users: Repository<User, { team: Team | null }>;");
});
