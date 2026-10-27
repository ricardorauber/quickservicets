import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import type { TenancyApi } from "./features/tenancy/api.ts";
import { directoryClock } from "./features/tenancy/directory.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import { maskConnections } from "./features/tenancy/pools.ts";
import type { Endpoint } from "./http/server.ts";
import type { Repository } from "./repository.ts";
import { errorOf, startTestApp, type TestApp, type TestEndpointInput } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import { createSqliteTables } from "./testing/sql.ts";

const models = markTenancy([
  entity("Post", [field({ name: "title", type: "string" })]),
  entity("Plan", [field({ name: "name", type: "string" })], { tags: { tenancy: { on: true, options: { scope: "shared" } } } }),
]);
const [post, plan] = models;

const running: TestApp[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
const realNow = directoryClock.now;
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  directoryClock.now = realNow;
});

const as = (tenant: string) => ({ headers: { "x-tenant-id": tenant } });
const create = (tenant: string, title: string) => ({ method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenant }, body: JSON.stringify({ title }) });

async function start(database: DatabaseAdapter, tenancy: Record<string, unknown>, endpoints: TestEndpointInput[] = []) {
  const app = await startTestApp({ database, models, endpoints, config: { tenancy: { source: "config", strategy: "database", ...tenancy } } });
  running.push(app);
  return app;
}

/** A memory root whose tenant stores are counted as they open. */
function countingMemory() {
  const root = memoryAdapter();
  const opened: string[] = [];
  const forConnection = root.forConnection!.bind(root);
  root.forConnection = (connection) => {
    opened.push(String(connection));
    return forConnection(connection);
  };
  return { root, opened };
}

describe("forConnection", () => {
  test("each built-in adapter opens another database of its kind, refusing invalid connections without their value", () => {
    expect(sqliteAdapter({ path: ":memory:" }).forConnection("acme.db").kind).toBe("sqlite");
    expect(sqliteAdapter({ path: ":memory:" }).forConnection({ path: "acme.db" }).kind).toBe("sqlite");
    expect(postgresAdapter({ url: "postgres://localhost/a" }).forConnection({ url: "postgres://localhost/acme" }).kind).toBe("postgres");
    expect(mongodbAdapter({ url: "mongodb://localhost", database: "a" }).forConnection("mongodb://localhost/acme").kind).toBe("mongodb");
    expect(memoryAdapter().forConnection!("acme").kind).toBe("memory");
    const message = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as Error).message;
      }
      return "no error";
    };
    expect(message(() => postgresAdapter({ url: "postgres://localhost/a" }).forConnection("mysql://root:hunter2@db/acme"))).toBe("Invalid tenant connection for postgres: expected a postgres:// URL");
    expect(message(() => sqliteAdapter({ path: ":memory:" }).forConnection(42))).toBe("Invalid tenant connection for sqlite: expected a path text or { path }");
    expect(message(() => mongodbAdapter({ url: "mongodb://localhost", database: "a" }).forConnection("mongodb://localhost"))).toBe(
      "Invalid tenant connection for mongodb: name the database in the URL path or with { url, name }",
    );
    expect(message(() => memoryAdapter().forConnection!(""))).toBe("Invalid tenant connection for memory: expected a text");
  });

  test("an adapter without forConnection fails startup when tenants may use the database strategy", async () => {
    const database = { ...memoryAdapter(), forConnection: undefined } as DatabaseAdapter;
    const failure = await startTestApp({ database, models, config: { tenancy: { source: "config", strategy: "database" } } }).then(() => undefined, (error: Error) => error.message);
    expect(failure).toBe('tenancy failed in setup: tenancy strategy "database" needs an adapter with forConnection(); the memory adapter has none');
  });
});

describe("opening and scopes", () => {
  test("SQLite tenants store their posts in their own files, and shared records stay in the root database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-tenants-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of ["acme", "globex"]) {
      const file = sqliteAdapter({ path: join(dir, `${name}.db`) });
      await file.connect([post!]);
      await createSqliteTables(file.client!, [post!]);
      await file.disconnect();
    }
    const root = sqliteAdapter({ path: ":memory:" });
    const connect = root.connect.bind(root);
    root.connect = async (list) => {
      await connect(list);
      await createSqliteTables(root.client!, [plan!]);
    };
    const savePlan: Endpoint = async (repos) => (repos as Record<string, Repository>).plans!.create({ name: "pro" });
    const app = await start(root, { tenants: { acme: { connection: join(dir, "acme.db") }, globex: { connection: join(dir, "globex.db") } } }, [{ method: "POST", path: "/save-plan", handler: savePlan }]);
    expect((await app.fetch("/posts", create("acme", "acme's"))).status).toBe(201);
    expect((await app.fetch("/posts", create("globex", "globex's"))).status).toBe(201);
    expect((await app.fetch("/save-plan", { method: "POST", ...as("acme") })).status).toBe(200);
    const read = (name: string) => {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(join(dir, `${name}.db`));
      try {
        return db.query("select title from posts").all();
      } finally {
        db.close();
      }
    };
    expect(read("acme")).toEqual([{ title: "acme's" }]);
    expect(read("globex")).toEqual([{ title: "globex's" }]);
    expect(root.client!.query("select name from plans").all()).toEqual([{ name: "pro" }]);
  });

  test("ten concurrent first requests open one pool, and a tenant transaction cannot write shared records", async () => {
    const { root, opened } = countingMemory();
    const mixed: Endpoint = async (repos) =>
      (repos as unknown as { transaction<T>(fn: () => Promise<T>): Promise<T> }).transaction(async () => {
        await (repos as Record<string, Repository>).posts!.create({ title: "x" });
        await (repos as Record<string, Repository>).plans!.create({ name: "y" });
      });
    const app = await start(root, { tenants: { acme: { connection: "acme-store" } } }, [{ method: "POST", path: "/mixed", handler: mixed }]);
    const answers = await Promise.all(Array.from({ length: 10 }, () => app.fetch("/posts", as("acme"))));
    expect(answers.map((response) => response.status)).toEqual(Array(10).fill(200));
    expect(opened).toEqual(["acme-store"]);
    const failed = await app.fetch("/mixed", { method: "POST", ...as("acme") });
    expect(failed.status).toBe(500);
    expect(app.logs.some((entry) => JSON.stringify(entry).includes("Cannot write to root inside a transaction of tenant:acme; they use different databases"))).toBe(true);
  });
});

describe("limits, idle pools and failures", () => {
  test("past pools.max the least recently used idle pool closes; with every pool busy another tenant answers 503", async () => {
    const { root } = countingMemory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: Endpoint = async () => (await gate, { done: true });
    const app = await start(root, { pools: { max: 2 }, tenants: { a: { connection: "a" }, b: { connection: "b" }, c: { connection: "c" } } }, [{ path: "/slow", handler: slow }]);
    await app.fetch("/posts", as("a"));
    await app.fetch("/posts", as("b"));
    await app.fetch("/posts", as("c"));
    expect(app.logs.find((entry) => entry.message === "tenancy.pool.closed")).toMatchObject({ tenant: "a", reason: "evicted" });
    const busy = [app.fetch("/slow", as("b")), app.fetch("/slow", as("c"))];
    await Bun.sleep(5);
    const refused = await app.fetch("/posts", as("a"));
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await errorOf(refused)).toEqual({ status: 503, code: "TENANT_UNAVAILABLE", message: "Too many tenant databases are busy" });
    release();
    expect((await Promise.all(busy)).map((response) => response.status)).toEqual([200, 200]);
  });

  test("a pool unused for pools.idle closes as idle", async () => {
    let now = 1_000_000;
    directoryClock.now = () => now;
    const { root } = countingMemory();
    const app = await start(root, { tenants: { a: { connection: "a" }, b: { connection: "b" } } });
    await app.fetch("/posts", as("a"));
    now += 5 * 60_000;
    await app.fetch("/posts", as("b"));
    expect(app.logs.find((entry) => entry.message === "tenancy.pool.closed")).toMatchObject({ tenant: "a", reason: "idle" });
  });

  test("an unreachable PostgreSQL tenant answers 503, logs without the password, and is not retried within 10 seconds", async () => {
    let now = 1_000_000;
    directoryClock.now = () => now;
    const root = memoryAdapter();
    const tries: string[] = [];
    root.forConnection = (connection) => {
      tries.push("try");
      return postgresAdapter({ url: "postgres://localhost/none" }).forConnection(connection);
    };
    const app = await start(root, { pools: { connectTimeout: "2s" }, tenants: { acme: { connection: "postgres://app:hunter2@127.0.0.1:1/acme" } } });
    const response = await app.fetch("/posts", as("acme"));
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await errorOf(response)).toEqual({ status: 503, code: "TENANT_UNAVAILABLE", message: "Tenant database is unavailable" });
    const failure = app.logs.find((entry) => entry.message === "tenancy.pool.failed");
    expect(failure).toMatchObject({ tenant: "acme" });
    expect(JSON.stringify(app.logs)).not.toContain("hunter2");
    now += 1000;
    expect((await app.fetch("/posts", as("acme"))).status).toBe(503);
    expect(tries).toHaveLength(1);
    expect(maskConnections("connect postgres://app:hunter2@db/acme failed", [])).toBe("connect postgres://app:[secret]@db/acme failed");
  });
});

describe("shutdown and stats", () => {
  test("stopping waits for the request in progress, then closes every pool; stats reports them", async () => {
    const { root } = countingMemory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let finished = false;
    const slow: Endpoint = async () => {
      await gate;
      finished = true;
      return { done: true };
    };
    let api: TenancyApi | undefined;
    registerNative(defineFeature({ key: "test-stats", docs: { summary: "Test." }, after: ["tenancy"], setup: (ctx) => ctx.app.onStart(() => void (api = ctx.feature("tenancy"))) }));
    cleanups.push(() => unregisterNative("test-stats"));
    const app = await startTestApp({ database: root, models, endpoints: [{ path: "/slow", handler: slow }], config: { "test-stats": {}, tenancy: { source: "config", strategy: "database", tenants: { a: { connection: "a" }, b: { connection: "b" } } } } });
    running.push(app);
    await app.fetch("/posts", as("b"));
    const inFlight = app.fetch("/slow", as("a"));
    await Bun.sleep(5);
    expect(api!.stats()).toEqual({ open: 2, max: 50, opening: 0, failed: 0 });
    const stopping = app.stop();
    await Bun.sleep(20);
    expect(finished).toBe(false);
    release();
    await inFlight;
    await stopping;
    expect(finished).toBe(true);
    expect(api!.stats()).toEqual({ open: 0, max: 50, opening: 0, failed: 0 });
    const closed = app.logs.filter((entry) => entry.message === "tenancy.pool.closed").map((entry) => [entry.tenant, entry.reason]);
    expect(closed.sort()).toEqual([
      ["a", "shutdown"],
      ["b", "shutdown"],
    ]);
  });
});
