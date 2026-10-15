import { beforeEach, describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { HttpError } from "./errors.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";

const user = entity("User", [field({ name: "name", type: "string" })]);
const organization = entity("Organization", [
  field({ name: "name", type: "string" }),
  field({ name: "members", type: "refArray", target: "User", onDelete: "pull", optional: true, maxLength: 3 }),
]);
const models = [user, organization];

async function setup(adapter: DatabaseAdapter = memoryAdapter()) {
  await adapter.connect(models);
  if (adapter.kind === "sqlite") await createSqliteTables((adapter as unknown as { client: never }).client, models);
  if (adapter.kind === "postgres") await resetPostgresTables((adapter as unknown as { client: never }).client, models);
  const repos = createRepositories(models, adapter);
  const users = repos.users as Repository;
  const organizations = repos.organizations as Repository;
  const ids: Record<string, string> = {};
  for (const name of ["a", "b", "c", "d", "z"]) ids[name] = (await users.create({ name })).id;
  return { adapter, organizations, ids };
}

const fail = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return (error as HttpError).details;
  }
  throw new Error("expected an HttpError");
};

let organizations: Repository;
let ids: Record<string, string>;
let orgId: string;
beforeEach(async () => {
  ({ organizations, ids } = await setup());
  orgId = (await organizations.create({ name: "x", members: [ids.a, ids.b] })).id;
});

describe("full lists", () => {
  test("PATCH and PUT replace the stored list", async () => {
    expect((await organizations.update(orgId, { members: [ids.c] })).members).toEqual([ids.c]);
    expect((await organizations.replace(orgId, { name: "y", members: [ids.b] })).members).toEqual([ids.b]);
  });
});

describe("add and remove", () => {
  test("add appends at the end", async () => {
    expect((await organizations.update(orgId, { members: { add: [ids.c] } })).members).toEqual([ids.a, ids.b, ids.c]);
  });
  test("present ids stay in place and absent removals are ignored", async () => {
    expect((await organizations.update(orgId, { members: { add: [ids.a], remove: [ids.z] } })).members).toEqual([ids.a, ids.b]);
  });
  test("remove applies before add, and order of new ids is kept", async () => {
    expect((await organizations.update(orgId, { members: { remove: [ids.a], add: [ids.d, ids.c] } })).members).toEqual([ids.b, ids.d, ids.c]);
  });
  test("updatedAt is refreshed", async () => {
    const before = (await organizations.findById(orgId))!.updatedAt;
    expect((await organizations.update(orgId, { members: { add: [ids.c] } })).updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("validation", () => {
  test("the same id in add and remove conflicts", async () => {
    expect(await fail(organizations.update(orgId, { members: { add: [ids.a], remove: [ids.a] } }))).toEqual([
      { field: "members", message: "Conflicting operations" },
    ]);
  });
  test("unknown keys are rejected", async () => {
    expect(await fail(organizations.update(orgId, { members: { move: [ids.a] } }))).toEqual([
      { field: "members.move", message: "Unknown field" },
    ]);
  });
  test("duplicates inside add", async () => {
    expect(await fail(organizations.update(orgId, { members: { add: [ids.c, ids.c] } }))).toEqual([
      { field: "members.add[1]", message: "Duplicate item" },
    ]);
  });
  test("limits apply to the resulting list", async () => {
    await organizations.update(orgId, { members: { add: [ids.c] } });
    expect(await fail(organizations.update(orgId, { members: { add: [ids.d] } }))).toEqual([
      { field: "members", message: "Must have at most 3 items" },
    ]);
  });
  test("added ids must exist", async () => {
    expect(await fail(organizations.update(orgId, { members: { add: [Bun.randomUUIDv7()] } }))).toEqual([
      { field: "members[2]", message: "Referenced record not found" },
    ]);
  });
});

const concurrently = async (adapter: DatabaseAdapter) => {
  const { organizations, ids } = await setup(adapter);
  const { id } = await organizations.create({ name: "x", members: [ids.a] });
  await Promise.all([
    organizations.update(id, { members: { add: [ids.c] } }),
    organizations.update(id, { members: { add: [ids.d] } }),
  ]);
  const members = (await organizations.findById(id))!.members as string[];
  await adapter.disconnect();
  return { members: [...members].sort(), expected: [ids.a!, ids.c!, ids.d!].sort() };
};

test("concurrent PATCH requests keep both changes (SQLite)", async () => {
  const { members, expected } = await concurrently(sqliteAdapter({ path: ":memory:" }));
  expect(members).toEqual(expected);
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  test("concurrent PATCH requests keep both changes (PostgreSQL)", async () => {
    const { members, expected } = await concurrently(postgresAdapter({ url: postgresUrl }));
    expect(members).toEqual(expected);
  });
} else {
  test.skip("concurrent PATCH on PostgreSQL (set TEST_POSTGRES_URL to run)", () => {});
}
