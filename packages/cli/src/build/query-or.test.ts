import { describe, expect, test } from "bun:test";
import {
  conditionsOf,
  createRepositories,
  memoryAdapter,
  mongodbAdapter,
  postgresAdapter,
  sqliteAdapter,
  type DatabaseAdapter,
  type Repository,
} from "@quickservicets/core";
import { resetPostgresTables } from "../../../core/src/testing/postgres.ts";
import { createSqliteTables } from "../../../core/src/testing/sql.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

const models = parseProjectEntities(
  createProject({
    "entities/Organization.ts": 'import type { User } from "./User";\nexport type Organization = { name: string; active: boolean; members?: User[] }',
    "entities/User.ts":
      'import type { Organization } from "./Organization";\nexport type User = { email: string; role: "admin" | "owner" | "member"; active: boolean; organization?: Organization }',
  }),
);
const userModel = models.find((model) => model.entityName === "User")!;

const factories: [string, () => DatabaseAdapter][] = [
  ["memory", () => memoryAdapter()],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
];
if (process.env.TEST_POSTGRES_URL) factories.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `ss_or_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

describe("nesting", () => {
  test("and/or follow the call structure", () => {
    const conditions = conditionsOf(userModel, (u: any) => u.active.eq(true).and(u.role.eq("admin").or(u.role.eq("owner"))));
    expect(conditions).toEqual([
      { field: "active", op: "eq", value: true },
      { group: "or", conditions: [{ field: "role", op: "eq", value: "admin" }, { field: "role", op: "eq", value: "owner" }] },
    ]);
    const grouped = conditionsOf(userModel, (u: any) => u.role.eq("admin").or(u.email.eq("x")).and(u.active.eq(false)));
    expect(grouped).toEqual([
      { group: "or", conditions: [{ field: "role", op: "eq", value: "admin" }, { field: "email", op: "eq", value: "x" }] },
      { field: "active", op: "eq", value: false },
    ]);
    const nested = conditionsOf(userModel, (u: any) => u.role.eq("admin").and(u.active.eq(true)).or(u.role.eq("owner")));
    expect(nested).toEqual([
      {
        group: "or",
        conditions: [
          { group: "and", conditions: [{ field: "role", op: "eq", value: "admin" }, { field: "active", op: "eq", value: true }] },
          { field: "role", op: "eq", value: "owner" },
        ],
      },
    ]);
  });
});

describe.each(factories)("%s", (_, factory) => {
  async function setup() {
    const adapter = factory();
    await adapter.connect(models);
    const client = (adapter as unknown as { client: never }).client;
    if (adapter.kind === "sqlite") await createSqliteTables(client, models);
    if (adapter.kind === "postgres") await resetPostgresTables(client, models);
    const repos = createRepositories(models, adapter) as unknown as Record<string, Repository<any>>;
    const acme = await repos.organizations!.create({ name: "acme", active: true });
    const gone = await repos.organizations!.create({ name: "gone", active: false });
    await repos.organizations!.create({ name: "other", active: true });
    const ana = await repos.users!.create({ email: "ana@acme.com", role: "member", active: true, organization: acme.id });
    await repos.users!.create({ email: "bob@x.co", role: "admin", active: true });
    await repos.users!.create({ email: "cid@x.co", role: "owner", active: false });
    await repos.users!.create({ email: "dee@x.co", role: "member", active: true, organization: gone.id });
    return { adapter, repos, ana };
  }
  const emails = (records: { email: string }[]) => records.map((record) => record.email).sort();

  test("OR, AND inside OR and OR inside AND", async () => {
    const { adapter, repos } = await setup();
    const users = repos.users!;
    expect(emails(await users.where((u: any) => u.role.eq("admin").or(u.email.contains("@acme.com"))).toArray())).toEqual(["ana@acme.com", "bob@x.co"]);
    expect(emails(await users.where((u: any) => u.active.eq(true).and(u.role.eq("admin").or(u.role.eq("owner")))).toArray())).toEqual(["bob@x.co"]);
    expect(emails(await users.where((u: any) => u.role.eq("owner").and(u.active.eq(false)).or(u.role.eq("admin"))).toArray())).toEqual([
      "bob@x.co",
      "cid@x.co",
    ]);
    expect(await users.where((u: any) => u.role.eq("admin").or(u.role.eq("owner"))).count()).toBe(2);
    expect((await users.where((u: any) => u.email.eq("nobody").or(u.role.eq("owner"))).firstOrDefault())?.email).toBe("cid@x.co");
    await adapter.disconnect();
  });

  test("groups on a derived relation side", async () => {
    const { adapter, repos, ana } = await setup();
    const names = (await repos.organizations!.where((o: any) => o.members.contains(ana.id).or(o.active.eq(false))).toArray())
      .map((organization: { name: string }) => organization.name)
      .sort();
    expect(names).toEqual(["acme", "gone"]);
    await adapter.disconnect();
  });

  test("flat condition arrays still mean AND", async () => {
    const { adapter, repos } = await setup();
    const listed = await repos.users!.list({
      where: [
        { field: "active", op: "eq", value: true },
        { field: "role", op: "eq", value: "member" },
      ],
      sort: [{ field: "email", direction: "asc" }],
      limit: 10,
      offset: 0,
    });
    expect(emails(listed.data)).toEqual(["ana@acme.com", "dee@x.co"]);
    await adapter.disconnect();
  });
});
