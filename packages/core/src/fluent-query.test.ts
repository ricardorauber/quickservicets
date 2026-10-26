import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { createApp } from "./app.ts";
import { ConfigError } from "./config-error.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import { conditionsOf, createQuery, type Query, type QueryBackend, type QueryFields } from "./fluent-query.ts";
import { createServer } from "./http/server.ts";
import type { EntityModel } from "./model.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";

const user = entity("User", [
  field({ name: "email", type: "string" }),
  field({ name: "age", type: "number", optional: true }),
  field({ name: "active", type: "boolean" }),
  field({ name: "role", type: "enum", values: ["admin", "member"] }),
  field({ name: "secret", type: "string", optional: true, hidden: true }),
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
  factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `ss_fluent_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
}

type UserRecord = { id: string; createdAt: Date; updatedAt: Date; email: string; age?: number | null; active: boolean; role: "admin" | "member"; secret?: string | null };
type TeamRecord = { id: string; createdAt: Date; updatedAt: Date; name: string; users: string[] };

/** The users a team's reference array lists, as a typed query. */
const membersOf = (teams: Repository<TeamRecord>, id: string) => teams.related(id, "users") as unknown as Query<UserRecord>;

async function setup(factory: Factory, toArrayMax?: number) {
  const adapter = factory();
  await adapter.connect(models);
  const client = (adapter as unknown as { client: never }).client;
  if (adapter.kind === "sqlite") await createSqliteTables(client, models);
  if (adapter.kind === "postgres") await resetPostgresTables(client, models);
  const repos = createRepositories(models, adapter, { toArrayMax }) as Record<string, Repository>;
  const users = repos.users as unknown as Repository<UserRecord>;
  const teams = repos.teams as unknown as Repository<TeamRecord>;
  const ana = await users.create({ email: "ana@acme.com", age: 30, active: true, role: "admin", secret: "s" });
  const bob = await users.create({ email: "bob@other.org", age: 17, active: true, role: "member" });
  const cid = await users.create({ email: "cid@acme.com", active: false, role: "member" });
  await teams.create({ name: "data", users: [ana.id, bob.id] });
  await teams.create({ name: "ops", users: [] });
  return { adapter, users, teams, ana, bob, cid };
}

describe("compiled conditions", () => {
  test("handles produce the same conditions as the HTTP filters", () => {
    const conditions = conditionsOf<UserRecord>(user, (u) =>
      u.email.contains("ACME").and(u.age.gte(18)).and(u.role.in(["admin"])).and(u.age.exists()),
    );
    expect(conditions).toEqual([
      { field: "email", op: "contains", value: "ACME", caseInsensitive: true, literal: true },
      { field: "age", op: "gte", value: 18 },
      { field: "role", op: "in", value: ["admin"] },
      { field: "age", op: "exists", value: true },
    ]);
    expect(conditionsOf<TeamRecord>(team, (t) => t.users.containsAny(["a", "b"]).and(t.users.isEmpty(false)))).toEqual([
      { field: "users", op: "containsAny", value: ["a", "b"] },
      { field: "users", op: "isEmpty", value: false },
    ]);
  });

  test("operators a field does not accept throw", () => {
    expect(() => conditionsOf<UserRecord>(user, (u) => (u.role as unknown as { contains(v: string): never }).contains("a"))).toThrow(
      'Operator "contains" is not allowed on User.role',
    );
  });

  test("the handles of a model are built once and reused by every query", () => {
    const seen: unknown[] = [];
    const lambda = (u: QueryFields<UserRecord>) => {
      seen.push(u);
      return u.age.gte(18);
    };
    conditionsOf<UserRecord>(user, lambda);
    conditionsOf<UserRecord>(user, lambda);
    conditionsOf<TeamRecord>(team, (t) => {
      seen.push(t);
      return t.name.eq("data");
    });
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
    expect(conditionsOf<UserRecord>(user, lambda)).toEqual([{ field: "age", op: "gte", value: 18 }]);
  });
});

test("lambdas are type-checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-fluent-"));
  const file = join(dir, "check.ts");
  const core = join(import.meta.dir, "index.ts");
  writeFileSync(
    file,
    `import type { Repository } from ${JSON.stringify(core)};
type User = { id: string; createdAt: Date; updatedAt: Date; email: string; age?: number | null; active: boolean; role: "admin" | "member"; teams: string[] };
declare const users: Repository<User>;
users.where((u) => u.email.contains("a").and(u.age.gte(18)).and(u.role.eq("admin")).and(u.teams.contains("t")).and(u.createdAt.gt(new Date())));
// @ts-expect-error unknown field
users.where((u) => u.actve.eq(true));
// @ts-expect-error a number compared with a string
users.where((u) => u.age.gte("x"));
// @ts-expect-error strings have no gte
users.where((u) => u.email.gte(1));
// @ts-expect-error enums only take their values
users.where((u) => u.role.eq("owner"));
async function terminals() {
  const records: User[] = await users.where((u) => u.role.eq("admin")).toArray();
  const every: boolean = await users.where((u) => u.role.eq("admin")).all((u) => u.active.eq(true));
  const some: boolean = await users.query().any((u) => u.age.gt(60));
  // @ts-expect-error all needs a condition
  await users.where((u) => u.role.eq("admin")).all();
  return { records, every, some };
}
terminals;
`,
  );
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(file));
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
});

test("aggregate expressions are type-checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-aggregate-"));
  const file = join(dir, "check.ts");
  const core = join(import.meta.dir, "index.ts");
  writeFileSync(
    file,
    `import type { Repository } from ${JSON.stringify(core)};
type User = { id: string; createdAt: Date; updatedAt: Date; email: string; age?: number | null; role: "admin" | "member"; teams: string[] };
declare const users: Repository<User>;
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const expect = <T extends true>() => {};
async function check(ids: string[]) {
  const stats = await users.where((u) => u.id.in(ids)).aggregate((u) => ({ members: u.count(), admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }));
  expect<Equal<typeof stats, { members: number; admins: number; averageAge: number | null }>>();
  const ranges = await users.query().aggregate((u) => ({ total: u.age.sum(), youngest: u.age.min(), oldest: u.age.max(), first: u.createdAt.min(), last: u.updatedAt.max() }));
  expect<Equal<typeof ranges, { total: number | null; youngest: number | null; oldest: number | null; first: Date | null; last: Date | null }>>();
  // @ts-expect-error strings have no sum
  await users.query().aggregate((u) => ({ total: u.email.sum() }));
  // @ts-expect-error enums have no avg
  await users.query().aggregate((u) => ({ average: u.role.avg() }));
  // @ts-expect-error dates have no sum
  await users.query().aggregate((u) => ({ total: u.createdAt.sum() }));
  // @ts-expect-error reference arrays have no max
  await users.query().aggregate((u) => ({ most: u.teams.max() }));
  // @ts-expect-error count takes a condition
  await users.query().aggregate((u) => ({ admins: u.count("admin") }));
  // @ts-expect-error values must be aggregate expressions
  await users.query().aggregate((u) => ({ admins: u.role.eq("admin") }));
}
check;
`,
  );
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(file));
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
  // Expressions that escape the types fail with a descriptive error.
  const invalid = createQuery<UserRecord>({ model: user } as QueryBackend, { where: [], sort: [], skip: 0 });
  expect(() => invalid.aggregate((u) => ({ total: (u.email as never as { sum(): never }).sum() }))).toThrow('Aggregate "sum" is not allowed on User.email');
  expect(() => invalid.aggregate((u) => ({ admins: u.role.eq("admin") as never }))).toThrow("An aggregate lambda on User must return an object of aggregate expressions");
});

describe.each(factories)("%s", (_, factory) => {
  test("aggregate expressions per type", async () => {
    const { adapter, users, ana, bob, cid } = await setup(factory);
    const statements: string[] = [];
    if (adapter.kind === "postgres") {
      const client = (adapter as unknown as { client: { unsafe(query: string, params?: unknown[]): unknown } }).client;
      const unsafe = client.unsafe.bind(client);
      client.unsafe = (query, params) => (statements.push(query), unsafe(query, params));
    }
    const pair = await users
      .where((u) => u.id.in([ana.id, bob.id]))
      .aggregate((u) => ({ members: u.count(), admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }));
    expect(pair).toEqual({ members: 2, admins: 1, averageAge: 23.5 });
    if (adapter.kind === "postgres") expect(statements).toHaveLength(1);
    const everyone = await users.query().aggregate((u) => ({
      members: u.count(),
      inactiveOrMinor: u.count(u.active.eq(false).or(u.age.lt(18))),
      ageSum: u.age.sum(),
      ageAvg: u.age.avg(),
      youngest: u.age.min(),
      oldest: u.age.max(),
      firstCreated: u.createdAt.min(),
      lastCreated: u.createdAt.max(),
    }));
    expect(everyone).toEqual({
      members: 3,
      inactiveOrMinor: 2,
      ageSum: 47,
      ageAvg: 23.5,
      youngest: 17,
      oldest: 30,
      firstCreated: ana.createdAt,
      lastCreated: cid.createdAt,
    });
    expect(everyone.firstCreated).toBeInstanceOf(Date);
    // skip and take do not limit aggregates, like count().
    expect(await users.query().take(1).aggregate((u) => ({ members: u.count() }))).toEqual({ members: 3 });
    await adapter.disconnect();
  });

  test("aggregates without matches are 0 for counts and null otherwise", async () => {
    const { adapter, users } = await setup(factory);
    const stats = (ids: string[]) =>
      users.where((u) => u.id.in(ids)).aggregate((u) => ({ members: u.count(), admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }));
    expect(await stats([])).toEqual({ members: 0, admins: 0, averageAge: null });
    expect(await stats([Bun.randomUUIDv7()])).toEqual({ members: 0, admins: 0, averageAge: null });
    expect(await users.where((u) => u.email.eq("nobody@x.co")).aggregate((u) => ({ total: u.age.sum(), last: u.updatedAt.max() }))).toEqual({
      total: null,
      last: null,
    });
    await adapter.disconnect();
  });

  test("chained where and and narrow the results", async () => {
    const { adapter, users, teams, ana, bob } = await setup(factory);
    const acmeActive = await users.where((u) => u.email.contains("ACME").and(u.active.eq(true))).toArray();
    expect(acmeActive.map((record) => record.id)).toEqual([ana.id]);
    const adults = await users.where((u) => u.active.eq(true)).where((u) => u.age.gte(18)).toArray();
    expect(adults.map((record) => record.email)).toEqual(["ana@acme.com"]);
    expect((await teams.where((t) => t.users.contains(bob.id)).toArray()).map((record) => record.name)).toEqual(["data"]);
    expect(await users.where((u) => u.createdAt.gt(new Date(0))).count()).toBe(3);
    await adapter.disconnect();
  });

  test("toArray() returns the matches and honors skip, take, select, include and the cap", async () => {
    const { adapter, users, teams, ana, bob, cid } = await setup(factory, 2);
    await expect(users.query().toArray()).rejects.toThrow("Query on User matched more than repositories.toArrayMax (2) records");
    expect((await users.where((u) => u.active.eq(true)).toArray()).map((record) => record.id)).toEqual([bob.id, ana.id]);
    expect((await users.where((u) => u.role.eq("admin")).toArray()).map((record) => record.id)).toEqual([ana.id]);
    expect((await users.query().take(2).toArray()).map((record) => record.id)).toEqual([cid.id, bob.id]);
    expect((await users.query().skip(1).take(1).toArray()).map((record) => record.id)).toEqual([bob.id]);
    expect(await users.where((u) => u.role.eq("admin")).select("email").toArray()).toEqual([{ id: ana.id, email: "ana@acme.com" }]);
    const [data] = await teams.where((t) => t.name.eq("data")).include("users").toArray();
    expect((data!.users as unknown as UserRecord[]).map((member) => member.email).sort()).toEqual(["ana@acme.com", "bob@other.org"]);
    await adapter.disconnect();
  });

  test("all(condition) is true, false and true without matches, without loading records", async () => {
    const { adapter, users, teams, ana, bob } = await setup(factory);
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
    const admins = users.where((u) => u.role.eq("admin"));
    expect(await admins.all((u) => u.active.eq(true))).toBe(true);
    if (adapter.kind === "postgres") expect(statements).toHaveLength(1);
    await users.update(ana.id, { active: false });
    expect(await admins.all((u) => u.active.eq(true))).toBe(false);
    await users.update(ana.id, { role: "member", active: true });
    expect(await admins.all((u) => u.active.eq(true))).toBe(true);
    // Like count(), skip and take do not narrow the matches.
    expect(await users.query().take(1).all((u) => u.active.eq(true))).toBe(false);
    expect(await users.where((u) => u.email.contains("acme")).all((u) => u.email.contains("@"))).toBe(true);
    const team = (await teams.where((t) => t.name.eq("data")).firstOrDefault())!;
    reads.length = 0;
    expect(await membersOf(teams, team.id).all((u) => u.active.eq(true))).toBe(true);
    expect(await membersOf(teams, team.id).all((u) => u.id.eq(bob.id))).toBe(false);
    expect(await membersOf(teams, Bun.randomUUIDv7()).all((u) => u.active.eq(false))).toBe(true);
    expect(reads.filter((method) => method !== "findById")).toEqual([]);
    await adapter.disconnect();
  });

  test("any() with and without a condition", async () => {
    const { adapter, users, teams } = await setup(factory);
    const reads: string[] = [];
    const findMany = adapter.findMany.bind(adapter);
    adapter.findMany = (...args) => (reads.push("findMany"), findMany(...args));
    expect(await users.query().any((u) => u.age.gt(60))).toBe(false);
    expect(await users.query().any((u) => u.age.gt(20))).toBe(true);
    expect(await users.where((u) => u.role.eq("member")).any((u) => u.age.gt(20))).toBe(false);
    expect(await users.where((u) => u.role.eq("admin")).any()).toBe(true);
    expect(await users.where((u) => u.email.eq("nobody@x.co")).any()).toBe(false);
    expect(await users.query().skip(5).any((u) => u.active.eq(false))).toBe(true);
    const team = (await teams.where((t) => t.name.eq("data")).firstOrDefault())!;
    reads.length = 0;
    expect(await membersOf(teams, team.id).any((u) => u.role.eq("admin"))).toBe(true);
    expect(await membersOf(teams, team.id).any((u) => u.active.eq(false))).toBe(false);
    expect(reads).toEqual([]);
    await users.create({ email: "old@acme.com", age: 61, active: true, role: "member" });
    expect(await users.query().any((u) => u.age.gt(60))).toBe(true);
    await adapter.disconnect();
  });

  test("first, firstOrDefault, count, any and page", async () => {
    const { adapter, users, cid } = await setup(factory);
    const none = users.where((u) => u.email.eq("nobody@x.co"));
    expect(await none.firstOrDefault()).toBeNull();
    try {
      await none.first();
      throw new Error("expected 404");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect([(error as HttpError).status, (error as HttpError).message]).toEqual([404, "User not found"]);
    }
    expect((await users.query().first()).id).toBe(cid.id);
    expect(await users.where((u) => u.role.eq("member")).count()).toBe(2);
    expect(await users.where((u) => u.role.eq("admin")).any()).toBe(true);
    expect(await none.any()).toBe(false);
    const page = await users.query().page({ limit: 2, offset: 2 });
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(page.data).toHaveLength(1);
    expect((await users.query().page()).limit).toBe(20);
    await expect(users.query().page({ limit: 0 })).rejects.toThrow("Invalid query");
    await adapter.disconnect();
  });

  test("records come back like other reads", async () => {
    const { adapter, users } = await setup(factory);
    const [admin] = await users.where((u) => u.role.eq("admin")).toArray();
    expect(admin).not.toHaveProperty("secret");
    expect(admin!.createdAt).toBeInstanceOf(Date);
    const ordered = await users.query().toArray();
    expect(ordered.map((record) => record.email)).toEqual(["cid@acme.com", "bob@other.org", "ana@acme.com"]);
    await adapter.disconnect();
  });
});

test("all() without a condition throws before reaching the database", async () => {
  const calls: string[] = [];
  const spy = { model: user, toArrayMax: 100, notFound: () => new Error("missing") } as unknown as QueryBackend;
  for (const method of ["list", "count", "aggregate"] as const) (spy as unknown as Record<string, unknown>)[method] = async () => void calls.push(method);
  const query = createQuery<UserRecord>(spy, { where: [], sort: [], skip: 0 });
  await expect((query.all as unknown as () => Promise<boolean>)()).rejects.toThrow("all() needs a condition; use toArray() to read the records");
  expect(calls).toEqual([]);
});

describe("the toArray cap in the config", () => {
  const start = async (env: Record<string, string>, repositories?: Record<string, number>) => {
    const config = resolveConfig({ database: memoryAdapter(), ...(repositories ? { repositories } : {}) } as ServiceConfig, env);
    await config.database.connect(models);
    return { config, app: createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config }) };
  };

  test("QS_REPOSITORIES_TO_ARRAY_MAX and repositories.toArrayMax cap toArray()", async () => {
    const { config, app } = await start({ QS_REPOSITORIES_TO_ARRAY_MAX: "5" });
    expect(config.repositories?.toArrayMax).toBe(5);
    const users = app.repos.users as unknown as Repository<UserRecord>;
    for (let index = 0; index < 5; index++) await users.create({ email: `u${index}@x.co`, active: true, role: "member" });
    expect(await users.query().toArray()).toHaveLength(5);
    await users.create({ email: "u5@x.co", active: true, role: "member" });
    await expect(users.query().toArray()).rejects.toThrow("Query on User matched more than repositories.toArrayMax (5) records");
    expect((await start({}, { toArrayMax: 7 })).config.repositories?.toArrayMax).toBe(7);
  });

  test("the old repositories.findAllMax key fails with the new name", () => {
    expect(() => resolveConfig({ database: memoryAdapter(), repositories: { findAllMax: 5 } } as unknown as ServiceConfig, {})).toThrow(
      "repositories.findAllMax was renamed to repositories.toArrayMax",
    );
    expect(() => resolveConfig({ database: memoryAdapter(), repositories: { findAllMax: 5 } } as unknown as ServiceConfig, {})).toThrow(ConfigError);
  });
});

describe("paging errors", () => {
  /** A backend that records every database call. */
  const backend = () => {
    const calls: string[] = [];
    const spy: QueryBackend = {
      model: user,
      toArrayMax: 100,
      list: async () => {
        calls.push("list");
        return { data: [], total: 0 };
      },
      count: async () => {
        calls.push("count");
        return 0;
      },
      aggregate: async () => {
        calls.push("aggregate");
        return {};
      },
      notFound: () => new HttpError(404, "User not found"),
    };
    return { calls, query: createQuery<UserRecord>(spy, { where: [], sort: [], skip: 0 }) };
  };
  const failure = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const { status, message, details } = error as HttpError;
      return { status, message, details };
    }
    throw new Error("expected an HttpError");
  };
  const LIMIT = { field: "limit", message: "Must be an integer from 1 to 100" };
  const OFFSET = { field: "offset", message: "Must be an integer of at least 0" };

  test("page rejects an invalid limit, offset or both before querying", async () => {
    const { calls, query } = backend();
    expect(await failure(() => query.page({ limit: 2, offset: 1.5 }))).toEqual({ status: 400, message: "Invalid query", details: [OFFSET] });
    expect((await failure(() => query.page({ limit: 101 }))).details).toEqual([LIMIT]);
    expect((await failure(() => query.page({ limit: 2.5 }))).details).toEqual([LIMIT]);
    expect((await failure(() => query.page({ limit: 0, offset: -1 }))).details).toEqual([LIMIT, OFFSET]);
    expect(calls).toEqual([]);
    expect(await query.page({ limit: 2, offset: 2 })).toEqual({ data: [], total: 0, limit: 2, offset: 2 });
  });

  test("skip and take reject negative and fractional values", async () => {
    const { query } = backend();
    const atLeastZero = (field: string) => ({ status: 400, message: "Invalid query", details: [{ field, message: "Must be an integer of at least 0" }] });
    expect(await failure(() => query.skip(-1))).toEqual(atLeastZero("skip"));
    expect(await failure(() => query.skip(0.5))).toEqual(atLeastZero("skip"));
    expect(await failure(() => query.take(1.5))).toEqual(atLeastZero("take"));
    expect(await failure(() => query.take(-2))).toEqual(atLeastZero("take"));
    expect(() => query.skip(0).take(0)).not.toThrow();
  });

  test("a custom endpoint answers 400 Invalid query", async () => {
    const { adapter, users } = await setup(() => memoryAdapter());
    const server = createServer({
      routes: [
        { method: "GET", path: "/users/paged", handler: () => users.query().page({ limit: 2, offset: 1.5 }) },
        { method: "GET", path: "/users/valid", handler: () => users.query().page({ limit: 2, offset: 2 }) },
      ],
      repos: {} as never,
      config: { production: true },
    });
    const response = await server.fetch(new Request("http://localhost/users/paged"));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"offset","message":"Must be an integer of at least 0"}]}}');
    const valid = await server.fetch(new Request("http://localhost/users/valid"));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ total: 3, limit: 2, offset: 2 });
    await adapter.disconnect();
  });
});
