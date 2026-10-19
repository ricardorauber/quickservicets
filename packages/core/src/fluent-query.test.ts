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
import { HttpError } from "./errors.ts";
import { conditionsOf, createQuery, type QueryBackend } from "./fluent-query.ts";
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

async function setup(factory: Factory, findAllMax?: number) {
  const adapter = factory();
  await adapter.connect(models);
  const client = (adapter as unknown as { client: never }).client;
  if (adapter.kind === "sqlite") await createSqliteTables(client, models);
  if (adapter.kind === "postgres") await resetPostgresTables(client, models);
  const repos = createRepositories(models, adapter, { findAllMax }) as Record<string, Repository>;
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
});

test("lambdas are type-checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "quickservice-fluent-"));
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

describe.each(factories)("%s", (_, factory) => {
  test("chained where and and narrow the results", async () => {
    const { adapter, users, teams, ana, bob } = await setup(factory);
    const acmeActive = await users.where((u) => u.email.contains("ACME").and(u.active.eq(true))).all();
    expect(acmeActive.map((record) => record.id)).toEqual([ana.id]);
    const adults = await users.where((u) => u.active.eq(true)).where((u) => u.age.gte(18)).all();
    expect(adults.map((record) => record.email)).toEqual(["ana@acme.com"]);
    expect((await teams.where((t) => t.users.contains(bob.id)).all()).map((record) => record.name)).toEqual(["data"]);
    expect(await users.where((u) => u.createdAt.gt(new Date(0))).count()).toBe(3);
    await adapter.disconnect();
  });

  test("all() over the cap throws", async () => {
    const { adapter, users } = await setup(factory, 2);
    await expect(users.query().all()).rejects.toThrow("Query on User matched 3 records, more than repositories.findAllMax (2)");
    expect(await users.where((u) => u.active.eq(true)).all()).toHaveLength(2);
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
    const [admin] = await users.where((u) => u.role.eq("admin")).all();
    expect(admin).not.toHaveProperty("secret");
    expect(admin!.createdAt).toBeInstanceOf(Date);
    const ordered = await users.query().all();
    expect(ordered.map((record) => record.email)).toEqual(["cid@acme.com", "bob@other.org", "ana@acme.com"]);
    await adapter.disconnect();
  });
});

describe("paging errors", () => {
  /** A backend that records every database call. */
  const backend = () => {
    const calls: string[] = [];
    const spy: QueryBackend = {
      model: user,
      findAllMax: 100,
      list: async () => {
        calls.push("list");
        return { data: [], total: 0 };
      },
      count: async () => {
        calls.push("count");
        return 0;
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
