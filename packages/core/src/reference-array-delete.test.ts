import { describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { HttpError } from "./errors.ts";
import type { ArrayOnDeleteAction, EntityModel } from "./model.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";

const user = entity("User", [field({ name: "name", type: "string" })]);
const organizationWith = (onDelete: ArrayOnDeleteAction) =>
  entity("Organization", [
    field({ name: "name", type: "string" }),
    field({ name: "members", type: "refArray", target: "User", onDelete, optional: true }),
  ]);

type Factory = () => DatabaseAdapter;
const factories: [string, Factory][] = [
  ["memory", () => memoryAdapter()],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
];
if (process.env.TEST_POSTGRES_URL) factories.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `ss_del_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

async function setup(factory: Factory, models: EntityModel[]) {
  const adapter = factory();
  await adapter.connect(models);
  const client = (adapter as unknown as { client: never }).client;
  if (adapter.kind === "sqlite") await createSqliteTables(client, models);
  if (adapter.kind === "postgres") await resetPostgresTables(client, models);
  return { adapter, repos: createRepositories(models, adapter) as Record<string, Repository> };
}

const conflict = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return [(error as HttpError).status, (error as HttpError).message];
  }
  throw new Error("expected an HttpError");
};

describe.each(factories)("%s", (_, factory) => {
  test("pull removes the id, keeps the order and refreshes updatedAt", async () => {
    const { repos, adapter } = await setup(factory, [user, organizationWith("pull")]);
    const [a, b, c] = await Promise.all(["a", "b", "c"].map((name) => repos.users!.create({ name })));
    const org = await repos.organizations!.create({ name: "x", members: [a!.id, b!.id, c!.id] });
    await repos.users!.delete(b!.id);
    const after = (await repos.organizations!.findById(org.id))!;
    expect(after.members).toEqual([a!.id, c!.id]);
    expect(after.updatedAt.getTime()).toBeGreaterThan(org.updatedAt.getTime());
    await adapter.disconnect();
  });

  test("a pull below the minimum changes nothing", async () => {
    const team = entity("Team", [
      field({ name: "name", type: "string" }),
      field({ name: "members", type: "refArray", target: "User", onDelete: "pull", minLength: 1 }),
    ]);
    const { repos, adapter } = await setup(factory, [user, team]);
    const [only, other] = await Promise.all(["a", "b"].map((name) => repos.users!.create({ name })));
    const blocked = await repos.teams!.create({ name: "blocked", members: [only!.id] });
    const pulled = await repos.teams!.create({ name: "pulled", members: [only!.id, other!.id] });
    expect(await conflict(repos.users!.delete(only!.id))).toEqual([409, "Cannot delete: teams.members would have fewer than 1 item"]);
    expect(await repos.users!.findById(only!.id)).toMatchObject({ name: "a" });
    expect(await repos.teams!.findById(blocked.id)).toMatchObject({ members: [only!.id], updatedAt: blocked.updatedAt });
    expect(await repos.teams!.findById(pulled.id)).toMatchObject({ members: [only!.id, other!.id], updatedAt: pulled.updatedAt });
    await adapter.disconnect();
  });

  test("restrict blocks the delete", async () => {
    const { repos, adapter } = await setup(factory, [user, organizationWith("restrict")]);
    const member = await repos.users!.create({ name: "b" });
    await repos.organizations!.create({ name: "x", members: [member.id] });
    expect(await conflict(repos.users!.delete(member.id))).toEqual([409, "Cannot delete: referenced by organizations"]);
    expect(await repos.users!.findById(member.id)).not.toBeNull();
    await adapter.disconnect();
  });

  test("cascade deletes the owners", async () => {
    const { repos, adapter } = await setup(factory, [user, organizationWith("cascade")]);
    const member = await repos.users!.create({ name: "b" });
    const org = await repos.organizations!.create({ name: "x", members: [member.id] });
    const other = await repos.organizations!.create({ name: "y" });
    await repos.users!.delete(member.id);
    expect(await repos.organizations!.findById(org.id)).toBeNull();
    expect(await repos.organizations!.findById(other.id)).not.toBeNull();
    await adapter.disconnect();
  });

  test("a restrict deeper in a cascade chain deletes nothing", async () => {
    const team = entity("Team", [field({ name: "orgs", type: "refArray", target: "Organization", onDelete: "restrict", optional: true })]);
    const { repos, adapter } = await setup(factory, [user, organizationWith("cascade"), team]);
    const member = await repos.users!.create({ name: "b" });
    const org = await repos.organizations!.create({ name: "x", members: [member.id] });
    await repos.teams!.create({ orgs: [org.id] });
    expect((await conflict(repos.users!.delete(member.id)))[0]).toBe(409);
    expect(await repos.users!.findById(member.id)).not.toBeNull();
    expect(await repos.organizations!.findById(org.id)).not.toBeNull();
    await adapter.disconnect();
  });
});

test("deleting an owner leaves no junction rows (SQLite)", async () => {
  const { repos, adapter } = await setup(() => sqliteAdapter({ path: ":memory:" }), [user, organizationWith("pull")]);
  const member = await repos.users!.create({ name: "a" });
  const org = await repos.organizations!.create({ name: "x", members: [member.id] });
  await repos.organizations!.delete(org.id);
  const client = (adapter as unknown as { client: { query(sql: string): { get(): unknown } } }).client;
  expect(client.query("select count(*) as count from organizations__members").get()).toEqual({ count: 0 });
});
