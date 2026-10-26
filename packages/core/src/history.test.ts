import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entityModel, field } from "./entity-model.ts";
import { events } from "./features/events/index.ts";
import { actorOf, versionOf } from "./features/history/index.ts";
import { coveredEntities, excludedFields, historyModel, historyModels, isCovered, snapshotOf } from "./features/history/model.ts";
import { writeVersion } from "./features/history/store.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { EntityModel, ParsedTags } from "./model.ts";
import { withJobOperation, withOperation } from "./operation-context.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import { configureTransactions, runInTransaction, transaction } from "./transactions.ts";
import type { ServiceRequest } from "./hooks.ts";
import type { WriteEvent } from "./event-types.ts";

const tagged = (model: EntityModel, tags: ParsedTags): EntityModel => ({ ...model, tags });
const on = { on: true, options: {} };
const off = { on: false, options: {} };

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

type Repos = Record<string, Repository>;

/** Starts events and history the way a service does, on one memory database, with the history models added. */
async function startHistory(entities: EntityModel[], options: Record<string, unknown> = {}, adapter: DatabaseAdapter = memoryAdapter()) {
  const models = [...entities, ...historyModels(entities, (options.entities as "tagged" | "all" | undefined) ?? "tagged")];
  const resolved = resolveConfig({ database: adapter, events: {}, history: options } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await adapter.connect(models);
  configureTransactions(adapter);
  const repos = createRepositories(models, adapter) as unknown as Repos;
  await lifecycle.start({ repos } as never);
  stops.push(async () => {
    await lifecycle.shutdown();
    await lifecycle.stop();
  });
  return { repos, models, adapter };
}

type Version = { entityId: string; version: number; operation: string; actor: string; tenant?: string; requestId?: string; record: Record<string, unknown>; changed: string[] };
const versions = async (repos: Repos, key: string) =>
  ((await repos[key]!.query().all()) as unknown as Version[]).sort((a, b) => a.entityId.localeCompare(b.entityId) || a.version - b.version);

describe("coverage", () => {
  const user = entityModel("User", { name: field({ type: "string" }) });
  test("tagged entities are covered; with all, every regular entity unless @history off; system, link and internal entities only when tagged", () => {
    expect(isCovered(user, "tagged")).toBe(false);
    expect(isCovered(tagged(user, { history: on }), "tagged")).toBe(true);
    expect(isCovered(user, "all")).toBe(true);
    expect(isCovered(tagged(user, { history: off }), "all")).toBe(false);
    expect(isCovered(tagged(user, { history: off }), "tagged")).toBe(false);
    const system = { ...user, system: true } as EntityModel;
    const internal = { ...user, internal: true };
    const link = { ...user, internal: true, link: { left: { entity: "A", field: "b" }, right: { entity: "B", field: "a" } } };
    for (const model of [system, internal, link]) {
      expect(isCovered(model, "all")).toBe(false);
      expect(isCovered(tagged(model, { history: on }), "all")).toBe(true);
    }
    const historyOfUser = historyModel(user);
    expect(coveredEntities([user, { ...historyOfUser, feature: "history" }], "all")).toEqual([user]);
  });
});

describe("derived models", () => {
  test("names, tables, repository keys, fields and indexes", () => {
    const orderItem = historyModel(entityModel("OrderItem", { sku: field({ type: "string" }) }));
    expect(orderItem).toMatchObject({ key: "OrderItemHistory", entityName: "OrderItemHistory", name: "order-item-history", tableName: "order_item_history", repoKey: "orderItemHistory", system: true, internal: true });
    const user = historyModel(entityModel("User", { name: field({ type: "string" }) }, { schema: "auth" }));
    expect([user.tableName, user.repoKey, user.schema]).toEqual(["user_history", "userHistory", "auth"]);
    expect(user.fields.map((item) => [item.name, item.type, item.optional])).toEqual([
      ["entityId", "string", false],
      ["version", "number", false],
      ["operation", "enum", false],
      ["actor", "string", false],
      ["tenant", "string", true],
      ["requestId", "string", true],
      ["at", "date", false],
      ["record", "json", false],
      ["changed", "array", false],
    ]);
    expect(user.fields[1]).toMatchObject({ integer: true, min: 1 });
    expect(user.fields[2]).toMatchObject({ values: ["create", "update", "delete"] });
    expect(user.indexes).toEqual([{ fields: ["entityId", "version"], unique: true }, { fields: ["entityId", "at"] }]);
  });
});

describe("versions", () => {
  const user = tagged(entityModel("User", { name: field({ type: "string" }) }), { history: on });

  test("numbering follows each record, with operations, records and changed fields", async () => {
    const { repos } = await startHistory([user]);
    const created = (await repos.users!.create({ name: "A" })) as { id: string };
    await repos.users!.update(created.id, { name: "B" });
    await repos.users!.update(created.id, { name: "C" });
    const other = (await repos.users!.create({ name: "X" })) as { id: string };
    await repos.users!.delete(created.id);
    const stored = (await versions(repos, "userHistory")).filter((version) => version.entityId === created.id);
    expect(stored.map((version) => [version.version, version.operation])).toEqual([
      [1, "create"],
      [2, "update"],
      [3, "update"],
      [4, "delete"],
    ]);
    expect(stored[1]!.changed).toEqual(["name"]);
    expect(stored[3]!.record).toMatchObject({ id: created.id, name: "C" });
    expect((await versions(repos, "userHistory")).find((version) => version.entityId === other.id)!.version).toBe(1);
  });

  test("a version number taken in the meantime is read again and tried once more; a second conflict fails", async () => {
    const adapter = memoryAdapter();
    const model = historyModel(user);
    await adapter.connect([model]);
    const version = { entityId: "r1", operation: "update" as const, actor: "system", at: new Date(), record: {}, changed: [] };
    await writeVersion(adapter, model, version);
    // Reads that miss the stored versions, as another transaction's commit would make them.
    let stale = 1;
    const racing: DatabaseAdapter = { ...adapter, findMany: async (entity, options) => (stale-- > 0 ? { data: [], total: 0 } : adapter.findMany(entity, options)) };
    expect((await writeVersion(racing, model, version)).version).toBe(2);
    const blind: DatabaseAdapter = { ...adapter, findMany: async () => ({ data: [], total: 0 }) };
    await expect(writeVersion(blind, model, version)).rejects.toThrow("Version conflict");
  });

  const sqlAdapters: [string, () => DatabaseAdapter][] = [["sqlite", () => sqliteAdapter({ path: ":memory:" })]];
  if (process.env.TEST_POSTGRES_URL) sqlAdapters.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! })]);
  for (const [name, create] of sqlAdapters) {
    test(`${name}: a conflicting version is retried inside the same transaction, which still commits`, async () => {
      const adapter = create();
      const model = historyModel(entityModel("HistoryProbe", { name: field({ type: "string" }) }));
      await adapter.connect([model]);
      const client = (adapter as unknown as { client: never }).client;
      if (adapter.kind === "sqlite") await createSqliteTables(client, [model]);
      if (adapter.kind === "postgres") await resetPostgresTables(client, [model]);
      try {
        const version = { entityId: "r1", operation: "update" as const, actor: "system", at: new Date(), record: { name: "a", nested: { at: "x" } }, changed: ["name"] };
        await writeVersion(adapter, model, version);
        let stale = 1;
        const racing: DatabaseAdapter = Object.assign(Object.create(adapter) as DatabaseAdapter, {
          findMany: (entity: EntityModel, options: Parameters<DatabaseAdapter["findMany"]>[1]) => (stale-- > 0 ? Promise.resolve({ data: [], total: 0 }) : adapter.findMany(entity, options)),
        });
        await runInTransaction(adapter, async () => {
          expect((await writeVersion(racing, model, version)).version).toBe(2);
        });
        const { data } = await adapter.findMany(model, { where: [], sort: [{ field: "version", direction: "asc" }], limit: 10, offset: 0 });
        expect(data.map((row) => [row.version, row.record, row.changed])).toEqual([
          [1, { name: "a", nested: { at: "x" } }, ["name"]],
          [2, { name: "a", nested: { at: "x" } }, ["name"]],
        ]);
      } finally {
        await adapter.disconnect();
      }
    }, 20_000);
  }

  test("a rolled-back write stores no version, and a failing version insert rolls the write back", async () => {
    const adapter = memoryAdapter();
    const { repos } = await startHistory([user], {}, adapter);
    await expect(
      transaction(async () => {
        await repos.users!.create({ name: "lost" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await versions(repos, "userHistory")).toEqual([]);
    const insert = adapter.insert;
    adapter.insert = async (entity, record) => {
      if (entity.key === "UserHistory") throw new Error("history is down");
      return insert(entity, record);
    };
    await expect(repos.users!.create({ name: "kept out" })).rejects.toThrow("history is down");
    adapter.insert = insert;
    expect(await repos.users!.query().all()).toEqual([]);
  });
});

describe("actors", () => {
  const event = (actor: WriteEvent["actor"]) => ({ actor }) as WriteEvent;
  test("the user, else the job, else the queue, else the system", () => {
    expect(actorOf(event({ user: "u1", job: "j" }))).toBe("user:u1");
    expect(actorOf(event({ job: "cleanup" }))).toBe("job:cleanup");
    expect(actorOf(event({ queue: "mail" }))).toBe("queue:mail");
    expect(actorOf(event({ tenant: "t1" }))).toBe("system");
  });

  test("writes record the request's user, tenant and id, a job's name, or the system", async () => {
    const user = tagged(entityModel("User", { name: field({ type: "string" }) }), { history: on });
    const { repos } = await startHistory([user]);
    const req = { id: "req-1", user: { id: "u1" }, tenant: { id: "t1" } } as unknown as ServiceRequest;
    await withOperation({ requestId: "req-1", req }, () => repos.users!.create({ name: "request" }));
    await withJobOperation({ name: "cleanup", runId: "run-1" }, () => repos.users!.create({ name: "job" }));
    await repos.users!.create({ name: "script" });
    const stored = await versions(repos, "userHistory");
    const byName = (name: string) => stored.find((version) => version.record.name === name)!;
    expect(byName("request")).toMatchObject({ actor: "user:u1", tenant: "t1", requestId: "req-1" });
    expect(byName("job").actor).toBe("job:cleanup");
    expect(byName("script")).toMatchObject({ actor: "system" });
    expect(byName("script").tenant ?? undefined).toBeUndefined();
    expect(byName("script").requestId ?? undefined).toBeUndefined();
  });
});

describe("field exclusion", () => {
  test("@history off, @hidden and @sensitive fields are left out unless tagged @history on", () => {
    const account = entityModel("Account", {
      email: field({ type: "string" }),
      passwordHash: field({ type: "string", hidden: true }),
      taxId: { ...field({ type: "string" }), tags: { sensitive: on } },
      draft: { ...field({ type: "string" }), tags: { history: off } },
      recoveryCode: { ...field({ type: "string", hidden: true }), tags: { history: on } },
    });
    const excluded = excludedFields(account);
    expect(excluded).toEqual(["passwordHash", "taxId", "draft"]);
    const record = { id: "a", createdAt: new Date(0), updatedAt: new Date(0), email: "e", passwordHash: "h", taxId: "t", draft: "d", recoveryCode: "r" };
    expect(snapshotOf(record, excluded)).toEqual({ id: "a", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), email: "e", recoveryCode: "r" });
    const version = versionOf({ operation: "created", recordId: "a", actor: {}, at: new Date(0), before: null, after: record, changed: ["email"] } as unknown as WriteEvent, excluded);
    expect(Object.keys(version.record)).not.toContain("passwordHash");
  });
});

describe("cascades and the disabled path", () => {
  const organization = tagged(entityModel("Organization", { name: field({ type: "string" }) }), { history: on });
  const membership = tagged(entityModel("Membership", { role: field({ type: "string" }), organization: field({ type: "ref", target: "Organization", onDelete: "cascade" }) }), { history: on });
  const draft = entityModel("Draft", { text: field({ type: "string" }) });

  test("records deleted by a cascade get a delete version each", async () => {
    const { repos } = await startHistory([organization, membership, draft]);
    const org = (await repos.organizations!.create({ name: "Acme" })) as { id: string };
    for (const role of ["admin", "member"]) await repos.memberships!.create({ role, organization: org.id });
    await repos.organizations!.delete(org.id);
    const stored = await versions(repos, "membershipHistory");
    expect(stored.filter((version) => version.operation === "delete").map((version) => version.version)).toEqual([2, 2]);
    expect(stored.filter((version) => version.operation === "delete").map((version) => version.record.role).sort()).toEqual(["admin", "member"]);
  });

  test("only covered entities get a listener, and without the native no history model exists", async () => {
    const registered: string[] = [];
    const original = events.on;
    events.on = ((pattern: string, listener: never, options?: never) => {
      registered.push(pattern);
      return original(pattern, listener, options);
    }) as typeof events.on;
    try {
      const { models } = await startHistory([organization, membership, draft]);
      expect(registered).toEqual(["organization.written", "membership.written"]);
      expect(models.some((model) => model.key === "DraftHistory")).toBe(false);
    } finally {
      events.on = original;
    }
    expect(historyModels([draft], "tagged")).toEqual([]);
  });
});
