import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import type { DatabaseAdapter, StoredRecord } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { outboxDeliveryEntity } from "./features/events/delivery.ts";
import { outboxEventEntity } from "./features/events/outbox.ts";
import { queue, queueMessageEntity } from "./features/queues/index.ts";
import { directoryClock } from "./features/tenancy/directory.ts";
import relayJob from "./features/tenancy/jobs/relay.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import { stagedModel } from "./features/tenancy/relay.ts";
import { tenantOperations } from "./features/tenancy/tenants.ts";
import type { Endpoint } from "./http/server.ts";
import { jobRunEntity } from "./jobs/job-run.ts";
import type { Repository, RepositoryRegistry } from "./repository.ts";
import { runForTenant } from "./tenant-runs.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

const post = entity("Post", [field({ name: "title", type: "string" })]);
const messageModel = queueMessageEntity();
const eventModel = outboxEventEntity();
const deliveryModel = outboxDeliveryEntity();
const models = markTenancy([post, messageModel, eventModel, deliveryModel, jobRunEntity()]);
const stagedMessages = stagedModel(models.find((model) => model.key === "QueueMessage")!);

const running: TestApp[] = [];
const cleanups: (() => void)[] = [];
const realNow = directoryClock.now;
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
  directoryClock.now = realNow;
});

const all = async (adapter: DatabaseAdapter, model: typeof post) => (await adapter.findMany(model, { where: [], sort: [{ field: "id", direction: "asc" }], limit: 100, offset: 0 })).data;
const messageRow = (extra: Record<string, unknown> = {}): StoredRecord => {
  const at = new Date(directoryClock.now() - 60_000);
  return { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, queue: "mail", payload: {}, status: "waiting", priority: 0, runAt: at, attempt: 0, maxAttempts: 3, enqueuedAt: at, tenant: "acme", ...extra };
};

/** An app whose tenant acme has a memory database of its own, with queues and the outbox on. */
async function start(extra: Record<string, unknown> = {}, endpoints: Parameters<typeof startTestApp>[0] extends infer O ? (O extends { endpoints?: infer E } ? E : never) : never = []) {
  const root = memoryAdapter();
  const processed: string[] = [];
  const app = await startTestApp({
    database: root,
    models,
    endpoints,
    config: {
      tenancy: { source: "config", strategy: "database", tenants: { acme: { connection: `relay-${Bun.randomUUIDv7()}` } }, ...extra },
      queues: { pollInterval: "10ms" },
      events: { outbox: { dispatch: false } },
    },
    featureFolders: { queues: { queues: new Map([["mail", queue(async (ctx) => void processed.push(String((ctx.payload as { to?: string }).to)))]]) } },
    jobs: new Map([["tenancy/relay", relayJob]]),
  });
  running.push(app);
  const tenantStore = () => runForTenant("acme", () => (require("./database-scope.ts") as typeof import("./database-scope.ts")).currentDatabaseScope().adapter);
  return { app, root, processed, tenantStore };
}

describe("staging tables", () => {
  test("tenant migrations of database tenants create the three staging tables; schema tenants get none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-relay-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const root = sqliteAdapter({ path: join(dir, "root.db") });
    const config = resolveConfig({ database: root, tenancy: { source: "config", tenants: { acme: { strategy: "database", connection: join(dir, "acme.db") }, globex: {} } }, queues: {}, events: { outbox: true } } as ServiceConfig, {});
    await root.connect(models);
    const operations = tenantOperations({ config, models, projectRoot: dir, logger: { info() {}, warn() {}, error() {} } });
    await operations.migrate((await operations.directory.find("acme"))!);
    await operations.migrate((await operations.directory.find("globex"))!);
    const tables = (path: string) => {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(path);
      try {
        return (db.query("select name from sqlite_master where type = 'table' and name like 'qs_staged_%' order by name").all() as { name: string }[]).map((row) => row.name);
      } finally {
        db.close();
      }
    };
    expect(tables(join(dir, "acme.db"))).toEqual(["qs_staged_outbox_deliveries", "qs_staged_outbox_events", "qs_staged_queue_messages"]);
    expect(tables(join(dir, "root.db"))).toEqual([]);
    await root.disconnect();
  });
});

describe("staged inserts and the relay after commit", () => {
  test("a rolled-back transaction leaves nothing; a committed one relays its message, which is then processed", async () => {
    const work: Endpoint = async (repos, req) =>
      (repos as unknown as { transaction<T>(fn: () => Promise<T>): Promise<T> }).transaction(async () => {
        await (repos as Record<string, Repository>).posts!.create({ title: "with mail" });
        await req.queue.add("mail" as never, { to: "a@x.test" } as never);
        if (req.query.get("fail")) throw new Error("rolled back");
        return { ok: true };
      });
    const { app, root, processed, tenantStore } = await start({}, [{ method: "POST", path: "/work", handler: work }]);
    expect((await app.fetch("/work?fail=1", { method: "POST", headers: { "x-tenant-id": "acme" } })).status).toBe(500);
    const store = await tenantStore();
    expect(await all(store, stagedMessages)).toEqual([]);
    expect(await all(root, messageModel)).toEqual([]);
    expect((await app.fetch("/work", { method: "POST", headers: { "x-tenant-id": "acme" } })).status).toBe(200);
    for (let tries = 0; tries < 200 && processed.length === 0; tries++) await Bun.sleep(10);
    expect(processed).toEqual(["a@x.test"]);
    expect(await all(store, stagedMessages)).toEqual([]);
    expect((await all(root, messageModel)).map((row) => row.tenant)).toEqual(["acme"]);
  });
});

describe("sweeps", () => {
  test("rows left by a crash move when the pool opens again, once, however often the relay runs", async () => {
    const { app, root, tenantStore } = await start({ pools: { idle: "1s" } });
    const store = await tenantStore();
    const left = messageRow({ status: "completed" });
    await store.insert(stagedMessages, left);
    // The idle pool closes; the next request opens it again and the relay moves the row.
    let now = Date.now();
    directoryClock.now = () => now;
    now += 2000;
    await app.fetch("/posts", { headers: { "x-tenant-id": "acme" } });
    await Bun.sleep(20);
    expect(app.logs.some((entry) => entry.message === "tenancy.pool.closed" && entry.reason === "idle")).toBe(true);
    expect((await all(root, messageModel)).map((row) => row.id)).toEqual([left.id]);
    await store.insert(stagedMessages, left);
    await runForTenant("acme", async () => app.app.jobRunner.run({ job: "tenancy/relay", trigger: "manual", scheduledAt: new Date(), attempt: 1 }));
    expect((await all(root, messageModel)).map((row) => row.id)).toEqual([left.id]);
    expect(await all(store, stagedMessages)).toEqual([]);
  });

  test("an open pool's rows move within one relay.interval; the daily job moves the rows of a closed pool", async () => {
    const { app, root, tenantStore } = await start({ relay: { interval: "100ms" } });
    const store = await tenantStore();
    await store.insert(stagedMessages, messageRow({ status: "completed" }));
    for (let tries = 0; tries < 50 && (await all(root, messageModel)).length === 0; tries++) await Bun.sleep(20);
    expect(await all(root, messageModel)).toHaveLength(1);
    expect(app.logs.some((entry) => entry.message === "tenancy.relay.moved" && entry.level === "debug")).toBe(true);
  });

  test("the tenancy/relay job opens the pools of database tenants and moves their rows", async () => {
    const { app, root, tenantStore } = await start();
    const store = await tenantStore();
    await app.stop();
    await store.insert(stagedMessages, messageRow({ status: "completed" }));
    const again = await startTestApp({ database: root, models, config: { tenancy: { source: "config", strategy: "database", tenants: { acme: { connection: (app.config.features.find((f) => f.key === "tenancy")!.options.tenants as Record<string, { connection: string }>).acme!.connection } } }, queues: {}, events: { outbox: { dispatch: false } } }, jobs: new Map([["tenancy/relay", relayJob]]) });
    running.push(again);
    const run = await again.app.jobRunner.run({ job: "tenancy/relay", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    expect(run?.status).toBe("success");
    expect(await all(root, messageModel)).toHaveLength(1);
  });
});

describe("dedupe, order and failures", () => {
  test("staged messages with a live message's dedupe key are dropped; staged events keep their id order", async () => {
    const { app, root, tenantStore } = await start({ relay: { interval: "50ms" } });
    const store = await tenantStore();
    await root.insert(messageModel, messageRow({ queue: "idle", dedupeKey: "k", dedupeSlot: "idle:k", status: "waiting", tenant: null }));
    await store.insert(stagedMessages, messageRow({ queue: "idle", dedupeKey: "k", dedupeSlot: "idle:k" }));
    await store.insert(stagedMessages, messageRow({ queue: "idle", dedupeKey: "k", dedupeSlot: "idle:k" }));
    const stagedEvents = stagedModel(models.find((model) => model.key === "OutboxEvent")!);
    const ids = [Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    const at = new Date(directoryClock.now() - 60_000);
    for (const id of [...ids].reverse()) await store.insert(stagedEvents, { id, createdAt: at, updatedAt: at, type: "x.y", event: {}, at });
    const inserted: string[] = [];
    const insert = root.insert.bind(root);
    root.insert = (model, record) => (model.key === "OutboxEvent" && ids.includes(record.id) && inserted.push(record.id), insert(model, record));
    for (let tries = 0; tries < 50 && inserted.length < 3; tries++) await Bun.sleep(20);
    expect(inserted).toEqual(ids);
    expect((await all(root, messageModel)).filter((row) => row.dedupeKey === "k")).toHaveLength(1);
    expect(await all(store, stagedMessages)).toEqual([]);
    void app;
  });

  test("a failing shared database keeps the staged rows and logs tenancy.relay.failed; the next interval moves them", async () => {
    const { app, root, tenantStore } = await start({ relay: { interval: "50ms" } });
    const store = await tenantStore();
    const insert = root.insert.bind(root);
    let failures = 1;
    root.insert = (model, record) => (model.key === "QueueMessage" && failures-- > 0 ? Promise.reject(new Error("shared database down")) : insert(model, record));
    await store.insert(stagedMessages, messageRow({ status: "completed" }));
    for (let tries = 0; tries < 50 && (await all(root, messageModel)).length === 0; tries++) await Bun.sleep(20);
    expect(app.logs.find((entry) => entry.message === "tenancy.relay.failed")).toMatchObject({ tenant: "acme", error: { message: "shared database down" } });
    expect(await all(root, messageModel)).toHaveLength(1);
  });
});

describe("the reference", () => {
  test("lists relay.interval with its variable and the at-least-once statement", () => {
    const page = readFileSync(join(import.meta.dir, "../../../docs/src/content/docs/reference/features/tenancy.mdx"), "utf8");
    expect(page).toContain("`tenancy.relay.interval`");
    expect(page).toContain("QS_TENANCY_RELAY_INTERVAL");
    expect(page).toContain("delivery is at least once");
  });
});

void (null as unknown as RepositoryRegistry);
