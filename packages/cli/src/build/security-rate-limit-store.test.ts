import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFeatureLifecycle, memoryAdapter, resolveConfig, sqliteAdapter, type DatabaseAdapter, type EntityModel, type LogEntry, type ServiceConfig } from "@quickservice/core";
import { databaseRateLimitStore, rateLimitCounterEntity } from "../../../core/src/features/security/db-store.ts";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";

const logs: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
afterEach(() => {
  logs.length = 0;
});

const CONFIG = (adapter = "memoryAdapter()", security = '{ rateLimit: { store: "database" } }') => `import { defineConfig, memoryAdapter, sqliteAdapter, postgresAdapter } from "@quickservice/core";
export default defineConfig({ database: ${adapter}, security: ${security} });
`;
const POST = { "entities/Post.ts": "export type Post = { title: string };\n" };
const MINUTE = 60_000;
const model = rateLimitCounterEntity();
const failure = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    return (error as Error).message;
  }
  return "no failure";
};

/** A connected SQLite database with the counters table, as two app instances would share it. */
async function sharedDatabase(): Promise<DatabaseAdapter> {
  const adapter = sqliteAdapter({ path: ":memory:" });
  await adapter.connect([model]);
  const client = (adapter as unknown as { client: { run(sql: string): void } }).client;
  client.run('create table "rate_limit_counters" ("id" text primary key, "created_at" integer not null, "updated_at" integer not null, "key" text not null, "window_start" integer not null, "count" integer not null, "expires_at" integer not null)');
  return adapter;
}

describe("the entity and the startup checks", () => {
  test("the database store adds RateLimitCounter, without routes", async () => {
    const service = await startTestService({ files: { "quickservice.config.ts": CONFIG(), ...POST } });
    try {
      const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
      expect(models.find((candidate) => candidate.key === "RateLimitCounter")).toMatchObject({ system: true, internal: true, name: "rate-limit-counters", tableName: "rate_limit_counters", indexes: [{ fields: ["expiresAt"] }] });
      expect((await service.fetch("/rate-limit-counters")).status).toBe(404);
      for (let index = 0; index < 3; index++) expect((await service.fetch("/posts", { peer: "203.0.113.5" })).status).toBe(200);
    } finally {
      await service.stop();
    }
    const memory = await startTestService({ files: { "quickservice.config.ts": CONFIG("memoryAdapter()", "{}"), ...POST } });
    try {
      const models = (await import(join(memory.root, ".generated/models.ts"))).models as EntityModel[];
      expect(models.some((candidate) => candidate.key === "RateLimitCounter")).toBe(false);
    } finally {
      await memory.stop();
    }
  });

  for (const [name, adapter] of Object.entries({ sqlite: 'sqliteAdapter({ path: ":memory:" })', postgres: 'postgresAdapter({ url: "postgres://localhost/none" })' })) {
    test(`${name}: migration add creates the rate_limit_counters table`, async () => {
      const root = createLinkedProject({ "quickservice.config.ts": CONFIG(adapter), ...POST });
      const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
      expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?rate_limit_counters/);
      expect(created).toContain("expires_at");
    });
  }

  test("a database store without the entity or without increment() fails startup", async () => {
    const setUp = async (adapter: DatabaseAdapter, models: EntityModel[]) => {
      const config = resolveConfig({ database: adapter, logger } as ServiceConfig, { QS_SECURITY_RATE_LIMIT_STORE: "database" });
      const lifecycle = createFeatureLifecycle({ features: config.features, config, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
      await lifecycle.setup();
    };
    expect(await failure(() => setUp(memoryAdapter(), []))).toBe('security failed in setup: security.rateLimit.store is "database", but the build did not include RateLimitCounter; rebuild and run quickservice migration add');
    const withoutIncrement = { ...memoryAdapter(), increment: undefined } as DatabaseAdapter;
    expect(await failure(() => setUp(withoutIncrement, [model]))).toBe('security failed in setup: security.rateLimit.store "database" needs an adapter with increment()');
  });
});

describe("local decisions with batched syncs", () => {
  test("two instances sharing one database refuse once their synced total passes the limit", async () => {
    const database = await sharedDatabase();
    const instances = [databaseRateLimitStore({ adapter: database, model, logger }), databaseRateLimitStore({ adapter: database, model, logger })];
    const accepted = [0, 0];
    const perInterval: number[][] = [];
    let now = 1_000;
    // Each second, every instance tries three requests, then both sync, as their timers would.
    for (let interval = 0; interval < 5; interval++) {
      const round = instances.map((store, index) => {
        let passed = 0;
        for (let attempt = 0; attempt < 3; attempt++) if (store.hit("203.0.113.5", { limit: 10, windowMs: MINUTE, now }).allowed) passed++;
        accepted[index]! += passed;
        return passed;
      });
      perInterval.push(round);
      for (const store of instances) await store.sync();
      now += 1_000;
    }
    // Both refuse once the synced total passed 10.
    expect(perInterval.at(-1)).toEqual([0, 0]);
    const total = accepted[0]! + accepted[1]!;
    expect(total).toBeGreaterThanOrEqual(10);
    // No instance accepted more than the limit plus what the other accepted within one interval.
    const mostOfOneInterval = Math.max(...perInterval.map((round) => Math.max(...round)));
    for (const count of accepted) expect(count).toBeLessThanOrEqual(10 + mostOfOneInterval);
    expect(total).toBeLessThanOrEqual(10 + mostOfOneInterval);
    const stored = await database.findMany(model, { where: [], sort: [], limit: 10, offset: 0 });
    expect(stored.data.map((record) => record.count)).toEqual([total]);
    await database.disconnect();
  });

  test("100 hits within one interval send one increment per key", async () => {
    const database = await sharedDatabase();
    const calls: string[] = [];
    const counting = { ...database, increment: (entity: EntityModel, id: string, amounts: Record<string, number>, insert: Record<string, unknown>) => (calls.push(String(insert.key)), database.increment!(entity, id, amounts, insert as never)) } as DatabaseAdapter;
    const store = databaseRateLimitStore({ adapter: counting, model, logger });
    for (let index = 0; index < 100; index++) store.hit(index % 2 === 0 ? "a" : "b", { limit: 1000, windowMs: MINUTE, now: 1_000 + index });
    await store.sync();
    expect(calls.sort()).toEqual(["a", "b"]);
    expect((await database.findMany(model, { where: [], sort: [{ field: "key", direction: "asc" }], limit: 10, offset: 0 })).data.map((record) => [record.key, record.count])).toEqual([
      ["a", 50],
      ["b", 50],
    ]);
    await database.disconnect();
  });
});

describe("cleanup, failures and the final flush", () => {
  test("counters older than two windows are deleted", async () => {
    const database = await sharedDatabase();
    let clock = 1_000;
    const store = databaseRateLimitStore({ adapter: database, model, logger, now: () => clock });
    store.hit("old", { limit: 5, windowMs: MINUTE, now: clock });
    await store.sync();
    clock = 2 * MINUTE + 1;
    store.hit("new", { limit: 5, windowMs: MINUTE, now: clock });
    await store.sync();
    expect(await store.cleanup()).toBe(1);
    expect((await database.findMany(model, { where: [], sort: [], limit: 10, offset: 0 })).data.map((record) => record.key)).toEqual(["new"]);
    // Two cleanups at once are safe.
    clock = 10 * MINUTE;
    expect((await Promise.all([store.cleanup(), store.cleanup()])).reduce((total, removed) => total + removed, 0)).toBe(1);
    await database.disconnect();
  });

  test("a failing database keeps the counts, logs once a minute, and sends them once it recovers; shutdown flushes", async () => {
    const database = await sharedDatabase();
    let down = true;
    let clock = 1_000;
    const flaky = { ...database, increment: (...args: Parameters<NonNullable<DatabaseAdapter["increment"]>>) => (down ? Promise.reject(new Error("connection refused")) : database.increment!(...args)) } as DatabaseAdapter;
    const store = databaseRateLimitStore({ adapter: flaky, model, logger, now: () => clock });
    for (let index = 0; index < 3; index++) expect(store.hit("k", { limit: 10, windowMs: MINUTE, now: clock }).allowed).toBe(true);
    await store.sync();
    clock += 1_000;
    await store.sync();
    expect(logs.filter((entry) => entry.message === "security.rateLimit.store-failed")).toEqual([expect.objectContaining({ error: { message: "connection refused" } })]);
    clock += MINUTE;
    await store.sync();
    expect(logs.filter((entry) => entry.message === "security.rateLimit.store-failed")).toHaveLength(2);
    down = false;
    await store.sync();
    expect((await database.findMany(model, { where: [], sort: [], limit: 10, offset: 0 })).data.map((record) => record.count)).toEqual([3]);
    await database.disconnect();
  });

  test("onStop sends the pending counts", async () => {
    const database = memoryAdapter();
    await database.connect([model]);
    const config = resolveConfig({ database, logger, security: { rateLimit: { store: "database" } } } as ServiceConfig, {});
    const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [model], worker: { index: 0, count: 1, runsScheduledWork: true } });
    await lifecycle.setup();
    await lifecycle.start({ repos: {} as never, server: undefined as never });
    const middleware = lifecycle.middleware.find((entry) => entry.owner === "security" && entry.middleware.stage === "request")!.middleware;
    const request = new Request("http://localhost/posts");
    const run = (middleware as { run(ctx: unknown, next: () => Promise<Response>): Promise<Response> }).run;
    await run({ request, url: new URL(request.url), requestId: "r", errorResponse: async () => new Response() }, async () => new Response("ok"));
    expect((await database.findMany(model, { where: [], sort: [], limit: 10, offset: 0 })).data).toEqual([]);
    await lifecycle.stop();
    expect((await database.findMany(model, { where: [], sort: [], limit: 10, offset: 0 })).data.map((record) => [record.key, record.count])).toEqual([["unknown", 1]]);
  });
});
