import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { createApp, type App } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { configureDatabaseScopes, currentDatabaseScope, enableDatabaseScopes, withDatabaseScope, type DatabaseScope } from "./database-scope.ts";
import type { AnyEvent } from "./event-types.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { events } from "./features/events/index.ts";
import { outboxDeliveryEntity } from "./features/events/delivery.ts";
import { outboxEventEntity } from "./features/events/outbox.ts";
import { queue, queueMessageEntity, queues } from "./features/queues/index.ts";
import type { Endpoint } from "./http/server.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { EntityModel } from "./model.ts";
import { configureRepositories, repositoriesFor, type Repository, type RepositoryRegistry } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { afterCommit, configureTransactions, inTransaction, transaction } from "./transactions.ts";

const silent = { info() {}, warn() {}, error() {} };
const post = entity("Post", [field({ name: "title", type: "string" })]);
const queueModel = queueMessageEntity();
const outboxModel = outboxEventEntity();
const deliveryModel = outboxDeliveryEntity();
const models: EntityModel[] = [post, queueModel, outboxModel, deliveryModel];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const posts = (registry: RepositoryRegistry) => registry.posts as Repository;
const all = async (adapter: DatabaseAdapter, model: EntityModel) => (await adapter.findMany(model, { where: [], sort: [], limit: 100, offset: 0 })).data;

/** Two connected memory adapters, the second one's scope, and the root configured on the first. */
async function adapters(enabled: boolean) {
  const a = memoryAdapter();
  const b = memoryAdapter();
  await a.connect(models);
  await b.connect(models);
  configureRepositories(models);
  configureTransactions(a, silent);
  configureDatabaseScopes(a, repositoriesFor(a), enabled);
  const scopeB: DatabaseScope = { key: "tenant:b", adapter: b, repos: repositoriesFor(b), tenant: { id: "b" } };
  return { a, b, scopeB };
}

describe("root scope and enabling", () => {
  test("without enableDatabaseScopes the root scope is current and withDatabaseScope throws", async () => {
    const { a } = await adapters(false);
    expect(currentDatabaseScope().key).toBe("root");
    expect(currentDatabaseScope().adapter).toBe(a);
    expect(() => withDatabaseScope({ key: "tenant:x", adapter: a }, () => 1)).toThrow("Database scopes are not enabled");
    expect(() => enableDatabaseScopes()).toThrow("enableDatabaseScopes() is only available during feature setup");
  });

  test("with scopes on, the innermost scope is current in every continuation, and repos default to the adapter's", async () => {
    const { a, b, scopeB } = await adapters(true);
    const seen: string[] = [];
    await withDatabaseScope(scopeB, async () => {
      await Promise.resolve();
      seen.push(currentDatabaseScope().key);
      await withDatabaseScope({ key: "tenant:a", adapter: a }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(currentDatabaseScope().key);
        expect(currentDatabaseScope().repos).toBe(repositoriesFor(a));
      });
      seen.push(currentDatabaseScope().key);
    });
    seen.push(currentDatabaseScope().key);
    expect(seen).toEqual(["tenant:b", "tenant:a", "tenant:b", "root"]);
    expect(currentDatabaseScope().adapter).not.toBe(b);
  });
});

/** A service whose test feature turns scopes on and runs requests with `x-db: 2` in scope B. */
async function service(config: Partial<ServiceConfig> = {}, endpoints: { path: string; handler: Endpoint }[] = [], folders: Record<string, Record<string, Map<string, unknown>>> = {}) {
  const a = memoryAdapter();
  const b = memoryAdapter();
  await b.connect(models);
  registerNative(
    defineFeature({
      key: "test-scopes",
      docs: { summary: "Test." },
      setup(ctx) {
        enableDatabaseScopes();
        ctx.app.use({ stage: "handler", order: 200, run: (req, _res, next) => (req.headers.get("x-db") === "2" ? withDatabaseScope({ key: "tenant:b", adapter: b }, next) : next()) });
      },
    }),
  );
  cleanups.push(() => unregisterNative("test-scopes"));
  const resolved = resolveConfig({ database: a, logger: silent, "test-scopes": {}, ...config } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, featureFolders: folders, worker: { index: 0, count: 1, runsScheduledWork: false } });
  await lifecycle.setup();
  await a.connect(models);
  const app: App = createApp({
    models,
    crudRoutes: [],
    endpoints: endpoints.map((endpoint) => ({ method: "POST", path: endpoint.path, hooks: [], handler: endpoint.handler })),
    hooks: new Map(),
    config: resolved,
    runtimeRoutes: lifecycle.routes,
    middleware: lifecycle.middleware,
    server: lifecycle.server,
  });
  await lifecycle.start({ repos: app.repos as never, server: app.server });
  cleanups.push(async () => {
    await lifecycle.shutdown();
    await lifecycle.stop();
  });
  const call = (path: string, db?: string) => app.server.fetch(new Request(`http://localhost${path}`, { method: "POST", ...(db ? { headers: { "x-db": db } } : {}) }));
  return { a, b, app, call };
}

describe("global functions follow the current scope", () => {
  test("the global transaction and the handler's repos write in scope B, and a throw rolls back there", async () => {
    const { a, b, call } = await service({}, [
      {
        path: "/write",
        handler: (repos, req) =>
          transaction(async () => {
            await posts(repos as never).create({ title: "kept" });
            if (req.query.get("fail")) throw new Error("rolled back");
            return { ok: true };
          }),
      },
    ]);
    expect((await call("/write", "2")).status).toBe(200);
    expect((await call("/write?fail=1", "2")).status).toBe(500);
    expect((await all(b, post)).map((record) => record.title)).toEqual(["kept"]);
    expect(await all(a, post)).toEqual([]);
    expect((await call("/write")).status).toBe(200);
    expect((await all(a, post)).length).toBe(1);
  });

  test("queues.add and events.emit with the outbox insert their rows through scope B's adapter, carrying its key", async () => {
    const { a, b, call } = await service(
      { queues: {}, events: { outbox: true } } as Partial<ServiceConfig>,
      [
        {
          path: "/work",
          handler: async (repos) => {
            await transaction(async () => {
              await posts(repos as never).create({ title: "with work" });
              await queues.add("mail" as never, { to: "x" } as never);
              await events.emit("invoice.paid" as never, { id: "i1" } as never);
            });
            return { ok: true };
          },
        },
      ],
      { queues: { queues: new Map([["mail", queue(async () => {})]]) } },
    );
    const insertsA = spyOn(a, "insert");
    const insertsB = spyOn(b, "insert");
    expect((await call("/work", "2")).status).toBe(200);
    const intoB = insertsB.mock.calls.map(([model]) => model.key);
    expect(intoB).toEqual(expect.arrayContaining(["Post", "QueueMessage", "OutboxEvent"]));
    expect(insertsA.mock.calls.map(([model]) => model.key)).not.toContain("QueueMessage");
    const [message] = await all(b, queueModel);
    expect(message?.actor).toMatchObject({ scope: "tenant:b" });
    const outboxEvents = await all(b, outboxModel);
    const written = outboxEvents.map((row) => row.event as AnyEvent).find((event) => event.type === "post.created");
    expect(written?.actor).toMatchObject({ scope: "tenant:b" });
    expect(await all(a, outboxModel)).toEqual([]);
  });
});

describe("transactions and other databases", () => {
  test("a write through another scope inside a transaction fails; a view sharing the connection is allowed", async () => {
    const { a, b, scopeB } = await adapters(true);
    const rootPosts = posts(repositoriesFor(a));
    const failure = await transaction(async () => {
      await rootPosts.create({ title: "in a" });
      await withDatabaseScope(scopeB, () => posts(scopeB.repos).create({ title: "in b" }));
    }).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toBe("Cannot write to tenant:b inside a transaction of root; they use different databases");
    expect(await all(b, post)).toEqual([]);
    expect(await all(a, post)).toEqual([]);

    const view: DatabaseAdapter = { ...a, insert: (model, record) => a.insert(model, record), transaction: (fn) => a.transaction(fn), sharesConnectionWith: (other) => other === a };
    const committed: string[] = [];
    await transaction(async () => {
      await rootPosts.create({ title: "parent" });
      await withDatabaseScope({ key: "tenant:view", adapter: view }, async () => {
        expect(inTransaction()).toBe(true);
        await afterCommit(() => void committed.push("view"));
        await posts(repositoriesFor(view)).create({ title: "through the view" });
      });
      expect(committed).toEqual([]);
    });
    expect(committed).toEqual(["view"]);
    expect((await all(a, post)).map((record) => record.title).sort()).toEqual(["parent", "through the view"]);
  });
});

describe("the disabled fast path", () => {
  test("without scopes no async context is created or read per request", async () => {
    const adapter = memoryAdapter();
    await adapter.connect(models);
    const config = resolveConfig({ database: adapter, logger: silent, security: false } as ServiceConfig, {});
    const app = createApp({ models, crudRoutes: [], endpoints: [{ method: "GET", path: "/plain", hooks: [], handler: () => ({ scope: currentDatabaseScope().key }) }], hooks: new Map(), config });
    const reads = spyOn(AsyncLocalStorage.prototype, "getStore");
    const runs = spyOn(AsyncLocalStorage.prototype, "run");
    const response = await app.server.fetch(new Request("http://localhost/plain"));
    expect(await response.json()).toEqual({ scope: "root" });
    expect(reads).not.toHaveBeenCalled();
    expect(runs).not.toHaveBeenCalled();
    reads.mockRestore();
    runs.mockRestore();
  });
});
