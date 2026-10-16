import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  createRepositories,
  HttpError,
  memoryAdapter,
  mongodbAdapter,
  postgresAdapter,
  sqliteAdapter,
  type DatabaseAdapter,
  type Repository,
} from "@quickservice/core";
import { createSqliteTables } from "../../../core/src/testing/sql.ts";
import { resetPostgresTables } from "../../../core/src/testing/postgres.ts";
import { createProject } from "../testing/project.ts";
import { parseEntities } from "./parse-entities.ts";

type Factory = () => DatabaseAdapter;
const factories: [string, Factory][] = [
  ["memory", () => memoryAdapter()],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
];
if (process.env.TEST_POSTGRES_URL) factories.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `ss_rel_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

const project = (organization: string, user: string) =>
  parseEntities(
    createProject({
      "entities/Organization.ts": `import type { User } from "./User";\nexport type Organization = { name: string; ${organization} }`,
      "entities/User.ts": `import type { Organization } from "./Organization";\nexport type User = { name: string; ${user} }`,
    }),
  );

async function setup(factory: Factory, organization: string, user: string) {
  const models = project(organization, user);
  const adapter = factory();
  await adapter.connect(models);
  const client = (adapter as unknown as { client: never }).client;
  if (adapter.kind === "sqlite") await createSqliteTables(client, models);
  if (adapter.kind === "postgres") await resetPostgresTables(client, models);
  if (adapter.kind === "mongodb") {
    for (const model of models) await (adapter as unknown as { createIndexes(model: unknown): Promise<void> }).createIndexes(model);
  }
  const repos = createRepositories(models, adapter) as Record<string, Repository>;
  return { adapter, models, users: repos.users!, organizations: repos.organizations! };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return [(error as HttpError).status, (error as HttpError).details ?? (error as HttpError).message];
  }
  throw new Error("expected an HttpError");
};

describe.each(factories)("%s", (_, factory) => {
  test("N-N writes from one side are visible from the other", async () => {
    const { users, organizations, adapter } = await setup(factory, "users?: User[]", "organizations?: Organization[]");
    const org = await organizations.create({ name: "o1" });
    const user = await users.create({ name: "u1" });
    await users.update(user.id, { organizations: { add: [org.id] } });
    expect((await organizations.findById(org.id))!.users).toEqual([user.id]);
    await organizations.update(org.id, { users: [] });
    expect((await users.findById(user.id))!.organizations).toEqual([]);
    await adapter.disconnect();
  });

  test("N-N keeps an independent order on each side", async () => {
    const { users, organizations, adapter } = await setup(factory, "users?: User[]", "organizations?: Organization[]");
    const [o1, o2] = [await organizations.create({ name: "o1" }), await organizations.create({ name: "o2" })];
    const [u1, u2] = [await users.create({ name: "u1" }), await users.create({ name: "u2" })];
    await organizations.update(o1.id, { users: [u2.id, u1.id] });
    await users.update(u1.id, { organizations: [o2.id, o1.id] });
    expect((await organizations.findById(o1.id))!.users).toEqual([u2.id, u1.id]);
    expect((await users.findById(u1.id))!.organizations).toEqual([o2.id, o1.id]);
    await adapter.disconnect();
  });

  test("1-N derived writes move foreign keys and unlink removed records", async () => {
    const { users, organizations, adapter } = await setup(factory, "users?: User[]", "organization?: Organization");
    const org = await organizations.create({ name: "o1" });
    const [u1, u2] = [await users.create({ name: "u1" }), await users.create({ name: "u2" })];
    await organizations.update(org.id, { users: [u1.id, u2.id] });
    expect((await users.findById(u2.id))!.organization).toBe(org.id);
    expect((await organizations.findById(org.id))!.users).toEqual([u1.id, u2.id]);
    const before = (await users.findById(u2.id))!.updatedAt;
    await organizations.update(org.id, { users: { remove: [u2.id] } });
    const after = (await users.findById(u2.id))!;
    expect(after.organization).toBeNull();
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    await adapter.disconnect();
  });

  test("1-N derived writes cannot unlink a required foreign key", async () => {
    const { users, organizations, adapter } = await setup(factory, "users?: User[]", "organization: Organization");
    const org = await organizations.create({ name: "o1" });
    const user = await users.create({ name: "u1", organization: org.id });
    expect(await failure(organizations.update(org.id, { users: [] }))).toEqual([
      400,
      [{ field: "users", message: "Cannot unlink: organization is required" }],
    ]);
    expect((await users.findById(user.id))!.organization).toBe(org.id);
    await adapter.disconnect();
  });

  test("1-1 conflicts fail unless @onConflict replace moves the link", async () => {
    const strict = await setup(factory, "user?: User", "organization?: Organization");
    const org = await strict.organizations.create({ name: "o1" });
    const a = await strict.users.create({ name: "a" });
    const b = await strict.users.create({ name: "b" });
    await strict.organizations.update(org.id, { user: a.id });
    expect((await strict.users.findById(a.id))!.organization).toBe(org.id);
    expect((await strict.organizations.findById(org.id))!.user).toBe(a.id);
    const other = await strict.organizations.create({ name: "o2", user: b.id });
    expect((await failure(strict.organizations.update(other.id, { user: a.id })))[0]).toBe(409);
    await strict.adapter.disconnect();

    const replace = await setup(factory, "/** @onConflict replace */ user?: User", "organization?: Organization");
    const o1 = await replace.organizations.create({ name: "o1" });
    const o2 = await replace.organizations.create({ name: "o2" });
    const user = await replace.users.create({ name: "a" });
    await replace.organizations.update(o1.id, { user: user.id });
    await replace.organizations.update(o2.id, { user: user.id });
    expect((await replace.organizations.findById(o1.id))!.user).toBeNull();
    expect((await replace.organizations.findById(o2.id))!.user).toBe(user.id);
    await replace.adapter.disconnect();
  });

  test("deleting applies the rule of the side pointing to the record", async () => {
    const pull = await setup(factory, "users?: User[]", "organizations?: Organization[]");
    const org = await pull.organizations.create({ name: "o1" });
    const user = await pull.users.create({ name: "u1", organizations: [org.id] });
    await pull.organizations.delete(org.id);
    expect((await pull.users.findById(user.id))!.organizations).toEqual([]);
    await pull.adapter.disconnect();

    const restrict = await setup(factory, "users?: User[]", "/** @onDelete restrict */ organizations?: Organization[]");
    const kept = await restrict.organizations.create({ name: "o1" });
    await restrict.users.create({ name: "u1", organizations: [kept.id] });
    expect(await failure(restrict.organizations.delete(kept.id))).toEqual([409, "Cannot delete: referenced by users"]);
    await restrict.adapter.disconnect();
  });
});

test("an N-N relation uses one junction table and no column on either entity (SQLite)", async () => {
  const { adapter, users, organizations } = await setup(() => sqliteAdapter({ path: ":memory:" }), "users?: User[]", "organizations?: Organization[]");
  const org = await organizations.create({ name: "o1" });
  await users.create({ name: "u1", organizations: [org.id] });
  const client = (adapter as unknown as { client: Database }).client;
  const tables = (client.query("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[]).map((row) => row.name);
  expect(tables).toEqual(["organizations", "organizations__users", "users"]);
  const columns = (table: string) => (client.query(`pragma table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
  expect(columns("organizations")).not.toContain("users");
  expect(columns("users")).not.toContain("organizations");
});

test("a failure while syncing the other side rolls back the whole request (SQLite)", async () => {
  const { users, organizations } = await setup(() => sqliteAdapter({ path: ":memory:" }), "users?: User[]", "organization: Organization");
  const org = await organizations.create({ name: "o1" });
  const kept = await users.create({ name: "kept", organization: org.id });
  const free = await users.create({ name: "free", organization: (await organizations.create({ name: "o2" })).id });
  expect((await failure(organizations.update(org.id, { name: "renamed", users: [free.id] })))[0]).toBe(400);
  expect((await organizations.findById(org.id))!.name).toBe("o1");
  expect((await users.findById(kept.id))!.organization).toBe(org.id);
  expect((await users.findById(free.id))!.organization).not.toBe(org.id);
});
