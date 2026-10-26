import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { etagOf, ifMatch, listedTags } from "./entity-tags.ts";
import { entityModel, field } from "./entity-model.ts";
import { HttpError } from "./errors.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import "./index.ts";

const organization = entityModel("Organization", { name: field({ type: "string" }) });
const user = entityModel("User", { name: field({ type: "string" }), organization: field({ type: "ref", target: "Organization", optional: true, onDelete: "cascade" }) });
const models = [organization, user];
type UserRecord = { id: string; name: string; createdAt: Date; updatedAt: Date };

const failure = async (work: () => Promise<unknown>): Promise<HttpError> => {
  try {
    await work();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("expected a failure");
};

describe("If-Match comparison", () => {
  test("lists of tags match strongly, weak tags never match, and * matches", () => {
    expect(listedTags('"a", "b"')).toEqual(['"a"', '"b"']);
    expect(ifMatch('"x", "a"', '"a"')).toBe(true);
    expect(ifMatch('W/"a"', '"a"')).toBe(false);
    expect(ifMatch("*", '"a"')).toBe(true);
    expect(ifMatch('"b"', '"a"')).toBe(false);
  });
});

async function repositories(adapter: DatabaseAdapter) {
  await adapter.connect(models);
  const client = (adapter as unknown as { client: never }).client;
  if (adapter.kind === "sqlite") await createSqliteTables(client, models);
  if (adapter.kind === "postgres") await resetPostgresTables(client, models);
  const repos = createRepositories(models, adapter) as unknown as { users: Repository<UserRecord>; organizations: Repository };
  return repos;
}

describe("the repository ifMatch option", () => {
  test("update, replace and delete write only with the current tag, throwing 412 with it otherwise", async () => {
    const repos = await repositories(memoryAdapter());
    const created = (await repos.users.create({ name: "Ada" })) as UserRecord;
    const tag = etagOf(created);
    const updated = (await repos.users.update(created.id, { name: "Ada L." }, { ifMatch: tag })) as UserRecord;
    expect(updated.name).toBe("Ada L.");
    const stale = await failure(() => repos.users.update(created.id, { name: "Lost" }, { ifMatch: tag }));
    expect([stale.status, stale.code, stale.message, stale.headers]).toEqual([412, "PRECONDITION_FAILED", "Record was changed by another request", { etag: etagOf(updated) }]);
    expect(((await repos.users.findById(created.id)) as UserRecord).name).toBe("Ada L.");
    expect((await failure(() => repos.users.replace(created.id, { name: "R" }, { ifMatch: 'W/' + etagOf(updated) }))).status).toBe(412);
    const replaced = (await repos.users.replace(created.id, { name: "R" }, { ifMatch: "*" })) as UserRecord;
    expect((await failure(() => repos.users.delete(created.id, { ifMatch: etagOf(updated) }))).status).toBe(412);
    await repos.users.delete(created.id, { ifMatch: etagOf(replaced) });
    expect(await repos.users.findById(created.id)).toBeNull();
    expect((await failure(() => repos.users.update(created.id, { name: "x" }, { ifMatch: "*" }))).status).toBe(404);
  });

  test("a matching delete applies the @onDelete rules in the same transaction", async () => {
    const repos = await repositories(memoryAdapter());
    const org = (await repos.organizations.create({ name: "Acme" })) as UserRecord;
    for (const name of ["a", "b"]) await repos.users.create({ name, organization: org.id });
    await repos.organizations.delete(org.id, { ifMatch: etagOf(org) });
    expect(await repos.users.query().toArray()).toEqual([]);
  });

  const adapters: [string, () => DatabaseAdapter, () => DatabaseAdapter][] = [];
  const sqlitePath = join(mkdtempSync(join(tmpdir(), "qs-if-match-")), "db.sqlite");
  const sqlite = sqliteAdapter({ path: sqlitePath });
  adapters.push(["sqlite", () => sqlite, () => sqlite]);
  if (process.env.TEST_POSTGRES_URL) adapters.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! }), () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
  for (const [name, first, second] of adapters) {
    test(`${name}: of two concurrent writes with one tag, exactly one succeeds and the other gets 412`, async () => {
      const a = first();
      const repos = await repositories(a);
      const b = second();
      const other = b === a ? repos : (await b.connect(models), createRepositories(models, b) as unknown as typeof repos);
      try {
        const created = (await repos.users.create({ name: "start" })) as UserRecord;
        const tag = etagOf(created);
        const results = await Promise.allSettled([repos.users.replace(created.id, { name: "one" }, { ifMatch: tag }), other.users.replace(created.id, { name: "two" }, { ifMatch: tag })]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
        expect((rejected.reason as HttpError).status).toBe(412);
        const current = etagOf((await repos.users.findById(created.id))!);
        const deletes = await Promise.allSettled([repos.users.delete(created.id, { ifMatch: current }), other.users.delete(created.id, { ifMatch: current })]);
        expect(deletes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect([404, 412]).toContain(((deletes.find((result) => result.status === "rejected") as PromiseRejectedResult).reason as HttpError).status);
      } finally {
        await a.disconnect();
        if (b !== a) await b.disconnect();
      }
    }, 20_000);
  }
});
