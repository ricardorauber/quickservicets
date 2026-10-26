import { describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { conditionsOf, type Query, type QueryLambda } from "./fluent-query.ts";
import type { EntityModel } from "./model.ts";
import { createRepositories, readRepository, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";

const user = entity("User", [
  field({ name: "email", type: "string" }),
  field({ name: "age", type: "number", optional: true }),
  field({ name: "active", type: "boolean", optional: true }),
  field({ name: "role", type: "enum", values: ["admin", "member"] }),
]);
const team = entity("Team", [
  field({ name: "name", type: "string" }),
  field({ name: "users", type: "refArray", target: "User", onDelete: "pull", optional: true }),
]);
const models: EntityModel[] = [user, team];

type Factory = () => DatabaseAdapter;
const factories: [string, Factory][] = [
  ["memory", () => memoryAdapter()],
  ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
];
if (process.env.TEST_POSTGRES_URL) factories.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
if (process.env.TEST_MONGODB_URL) {
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `ss_negation_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

type UserRecord = { id: string; createdAt: Date; updatedAt: Date; email: string; age?: number | null; active?: boolean | null; role: "admin" | "member" };
type TeamRecord = { id: string; createdAt: Date; updatedAt: Date; name: string; users: string[] };

/** Ana is an active admin, Bob an active member, Cid an inactive member without an age and Dee an admin without `active`. */
async function setup(factory: Factory) {
  const adapter = factory();
  await adapter.connect(models);
  const client = (adapter as unknown as { client: never }).client;
  if (adapter.kind === "sqlite") await createSqliteTables(client, models);
  if (adapter.kind === "postgres") await resetPostgresTables(client, models);
  const repos = createRepositories(models, adapter) as Record<string, Repository>;
  const users = repos.users as unknown as Repository<UserRecord>;
  const teams = repos.teams as unknown as Repository<TeamRecord>;
  const ana = await users.create({ email: "ana", age: 30, active: true, role: "admin" });
  const bob = await users.create({ email: "bob", age: 17, active: true, role: "member" });
  const cid = await users.create({ email: "cid", active: false, role: "member" });
  const dee = await users.create({ email: "dee", age: 45, role: "admin" });
  const data = await teams.create({ name: "data", users: [ana.id, cid.id] });
  const ops = await teams.create({ name: "ops", users: [] });
  return { adapter, users, teams, data, ops, ana, bob, cid, dee };
}

/** Records every read that loads records, and on PostgreSQL every statement. */
function watch(adapter: DatabaseAdapter) {
  const reads: string[] = [];
  for (const method of ["findMany", "findById", "findRelated"] as const) {
    const original = adapter[method] as ((...args: unknown[]) => unknown) | undefined;
    if (original) (adapter as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => (reads.push(method), original.apply(adapter, args));
  }
  const statements: string[] = [];
  if (adapter.kind === "postgres") {
    const client = (adapter as unknown as { client: { unsafe(query: string, params?: unknown[]): unknown } }).client;
    const unsafe = client.unsafe.bind(client);
    client.unsafe = (query, params) => (statements.push(query), unsafe(query, params));
  }
  return { reads, statements };
}

const emails = async (query: Query<UserRecord>) => (await query.toArray()).map((record) => record.email).sort();

describe("not() builds a not group", () => {
  test("around one condition, or around the compound condition it is called on", () => {
    expect(conditionsOf<UserRecord>(user, (u) => u.age.gte(18).not())).toEqual([{ group: "not", conditions: [{ field: "age", op: "gte", value: 18 }] }]);
    expect(conditionsOf<UserRecord>(user, (u) => u.role.eq("admin").and(u.active.eq(true)).not())).toEqual([
      {
        group: "not",
        conditions: [{ group: "and", conditions: [{ field: "role", op: "eq", value: "admin" }, { field: "active", op: "eq", value: true }] }],
      },
    ]);
    expect(conditionsOf<UserRecord>(user, (u) => u.role.eq("admin").and(u.age.lt(18).or(u.active.eq(false)).not()))).toEqual([
      { field: "role", op: "eq", value: "admin" },
      {
        group: "not",
        conditions: [{ group: "or", conditions: [{ field: "age", op: "lt", value: 18 }, { field: "active", op: "eq", value: false }] }],
      },
    ]);
  });
});

describe.each(factories)("%s", (_, factory) => {
  test("none() with and without a condition, without loading records", async () => {
    const { adapter, users, teams, data, ops, ana } = await setup(factory);
    const { reads, statements } = watch(adapter);
    const active = users.where((u) => u.active.eq(true));
    expect(await active.none((u) => u.role.eq("admin"))).toBe(false);
    if (adapter.kind === "postgres") expect(statements).toHaveLength(1);
    expect(await active.none((u) => u.age.gt(40))).toBe(true);
    expect(await active.none()).toBe(false);
    expect(await users.where((u) => u.email.eq("nobody")).none()).toBe(true);
    // Like count(), skip and take do not narrow the matches.
    expect(await users.query().skip(10).take(1).none((u) => u.email.eq("dee"))).toBe(false);
    expect(await (teams.related(data.id, "users") as unknown as Query<UserRecord>).none((u) => u.role.eq("member"))).toBe(false);
    expect(await (teams.related(ops.id, "users") as unknown as Query<UserRecord>).none()).toBe(true);
    expect(reads.filter((method) => method !== "findById")).toEqual([]);
    await users.update(ana.id, { active: false });
    expect(await active.none((u) => u.role.eq("admin"))).toBe(true);
    await adapter.disconnect();
  });

  test("not() on a single and a compound condition matches null fields", async () => {
    const { adapter, users } = await setup(factory);
    // Comparisons never match a null field; their negation does.
    expect(await emails(users.where((u) => u.active.eq(true)))).toEqual(["ana", "bob"]);
    expect(await emails(users.where((u) => u.active.eq(true).not()))).toEqual(["cid", "dee"]);
    expect(await emails(users.where((u) => u.age.gte(18).not()))).toEqual(["bob", "cid"]);
    expect(await emails(users.where((u) => u.active.ne(false).not()))).toEqual(["cid", "dee"]);
    expect(await emails(users.where((u) => u.age.in([17, 30]).not()))).toEqual(["cid", "dee"]);
    // Every user except active admins, including Dee, whose `active` is null.
    expect(await emails(users.where((u) => u.role.eq("admin").and(u.active.eq(true)).not()))).toEqual(["bob", "cid", "dee"]);
    expect(await emails(users.where((u) => u.age.gte(18).or(u.active.eq(false)).not()))).toEqual(["bob"]);
    expect(await emails(users.where((u) => u.email.eq("ana").not().not()))).toEqual(["ana"]);
    expect(await users.count((u) => u.age.lt(18).not())).toBe(3);
    await adapter.disconnect();
  });

  test("not() nested inside or, in aggregate counts, on reference arrays and in related queries", async () => {
    const { adapter, users, teams, data, ana, cid } = await setup(factory);
    expect(await emails(users.where((u) => u.role.eq("member").and(u.age.lt(18).not()).or(u.active.eq(true).not())))).toEqual(["cid", "dee"]);
    expect(await emails(users.where((u) => u.email.eq("ana").or(u.role.eq("admin").or(u.age.gt(10)).not())))).toEqual(["ana", "cid"]);
    expect(await emails(users.where((u) => u.role.eq("admin").and(u.age.lt(40).or(u.active.eq(false)).not())))).toEqual(["dee"]);
    const stats = await users.query().aggregate((u) => ({
      all: u.count(),
      notActive: u.count(u.active.eq(true).not()),
      notActiveAdmins: u.count(u.role.eq("admin").and(u.active.eq(true)).not()),
      memberOrNotAdult: u.count(u.role.eq("member").or(u.age.gte(18).not())),
    }));
    expect(stats).toEqual({ all: 4, notActive: 2, notActiveAdmins: 3, memberOrNotAdult: 2 });
    expect(await users.where((u) => u.role.eq("member")).all((u) => u.age.gte(18).not())).toBe(true);
    expect(await users.where((u) => u.role.eq("admin")).all((u) => u.active.eq(true).not())).toBe(false);
    const teamNames = async (lambda: QueryLambda<TeamRecord>) => (await teams.where(lambda).toArray()).map((record) => record.name).sort();
    expect(await teamNames((t) => t.users.contains(ana.id).not())).toEqual(["ops"]);
    expect(await teamNames((t) => t.users.isEmpty().not())).toEqual(["data"]);
    const members = teams.related(data.id, "users") as unknown as Query<UserRecord>;
    expect(await emails(members.where((u) => u.active.eq(true).not()))).toEqual(["cid"]);
    expect(await members.count()).toBe(2);
    expect(await members.aggregate((u) => ({ notAdmins: u.count(u.role.eq("admin").not()) }))).toEqual({ notAdmins: 1 });
    expect(await members.any((u) => u.id.eq(cid.id).not().and(u.role.eq("member")))).toBe(false);
    await adapter.disconnect();
  });

  test("repository shortcuts equal their query() forms", async () => {
    const { adapter, users } = await setup(factory);
    const conditions: QueryLambda<UserRecord>[] = [(u) => u.role.eq("admin"), (u) => u.age.gt(60), (u) => u.email.contains("@").not(), (u) => u.active.eq(true).not()];
    for (const lambda of conditions) {
      expect(await users.any(lambda)).toBe(await users.query().any(lambda));
      expect(await users.all(lambda)).toBe(await users.query().all(lambda));
      expect(await users.none(lambda)).toBe(await users.query().none(lambda));
      expect(await users.count(lambda)).toBe(await users.query().where(lambda).count());
    }
    expect(await users.any((u) => u.role.eq("admin"))).toBe(true);
    expect(await users.all((u) => u.email.contains("@").not())).toBe(true);
    expect(await users.none((u) => u.age.gt(60))).toBe(true);
    expect(await users.count((u) => u.active.eq(true).not())).toBe(2);
    expect([await users.any(), await users.none(), await users.count()]).toEqual([await users.query().any(), await users.query().none(), await users.query().count()]);
    expect([await users.any(), await users.none(), await users.count()]).toEqual([true, false, 4]);
    // Read-only repositories offer them too.
    const readOnly = readRepository(users);
    expect([await readOnly.any((u) => u.role.eq("admin")), await readOnly.all((u) => u.age.gt(0)), await readOnly.none(), await readOnly.count()]).toEqual([true, false, false, 4]);
    await expect(users.all(undefined as never)).rejects.toThrow("all() needs a condition");
    await adapter.disconnect();
  });
});

// Type-level checks: this function is compiled by `bun run typecheck` but never called.
async function typed(users: Repository<UserRecord>) {
  const any: boolean = await users.any((u) => u.role.eq("admin"));
  const anyAtAll: boolean = await users.any();
  const all: boolean = await users.all((u) => u.active.eq(true).not());
  const none: boolean = await users.none((u) => u.age.gt(60).or(u.role.eq("admin").not()));
  const noneAtAll: boolean = await users.none();
  const count: number = await users.count((u) => u.email.contains("a").and(u.age.lt(18).not()));
  const total: number = await users.count();
  const queried: boolean = await users.where((u) => u.role.eq("admin").not()).none((u) => u.active.eq(true));
  // @ts-expect-error all needs a condition
  await users.all();
  // @ts-expect-error unknown field
  await users.none((u) => u.actve.eq(true));
  // @ts-expect-error not takes no argument
  await users.any((u) => u.role.eq("admin").not(u.active.eq(true)));
  // @ts-expect-error count resolves a number
  const wrong: boolean = await users.count();
  return [any, anyAtAll, all, none, noneAtAll, count, total, queried, wrong];
}

test("the shortcuts and not() are typed", () => {
  expect(typed).toBeDefined();
});
