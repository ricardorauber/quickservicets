import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { http, type HttpMock } from "./features/http/index.ts";
import { directoryClock } from "./features/tenancy/directory.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import type { Endpoint } from "./http/server.ts";
import { startTestApp, type TestApp, type TestEndpointInput } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import { createSqliteTables } from "./testing/sql.ts";

const models = markTenancy([entity("Post", [field({ name: "title", type: "string" })])]);
const [post] = models;
const SERVICES = { http: { services: { vault: { url: "http://vault.internal" } } } };

const running: TestApp[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
let mock: HttpMock | undefined;
const realNow = directoryClock.now;
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  mock?.restore();
  mock = undefined;
  directoryClock.now = realNow;
});

const as = (tenant: string) => ({ headers: { "x-tenant-id": tenant } });

/** A memory root recording the connections its tenant databases open with; `fail` makes chosen connects throw. */
function recordingMemory(fail?: (connection: unknown) => unknown) {
  const root = memoryAdapter();
  const opened: unknown[] = [];
  const forConnection = root.forConnection!.bind(root);
  root.forConnection = (connection) => {
    opened.push(connection);
    const adapter = forConnection(String(typeof connection === "object" ? JSON.stringify(connection) : connection));
    const error = fail?.(connection);
    return error ? { ...adapter, connect: () => Promise.reject(error) } : adapter;
  };
  return { root, opened };
}

async function start(database: DatabaseAdapter, tenancy: Record<string, unknown>, extra: Record<string, unknown> = {}, endpoints: TestEndpointInput[] = [], env: Record<string, string> = {}) {
  const app = await startTestApp({ database, models, endpoints, env, config: { tenancy: { source: "config", strategy: "database", ...tenancy }, ...extra } });
  running.push(app);
  return app;
}

describe("sources and precedence", () => {
  test("a template opens the tenant's SQLite file, and QS_TENANCY_CONNECTION replaces the template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-connections-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = sqliteAdapter({ path: join(dir, "tenant_acme.db") });
    await file.connect([post!]);
    await createSqliteTables(file.client!, [post!]);
    await file.disconnect();
    const root = sqliteAdapter({ path: ":memory:" });
    const opened: unknown[] = [];
    const forConnection = root.forConnection.bind(root);
    root.forConnection = (connection) => (opened.push(connection), forConnection(connection));
    const app = await start(root, { connection: join(dir, "tenant_{tenant}.db"), tenants: { acme: {} } });
    expect((await app.fetch("/posts", as("acme"))).status).toBe(200);
    expect(opened).toEqual([join(dir, "tenant_acme.db")]);

    const memory = recordingMemory();
    const overridden = await start(memory.root, { connection: "store-{tenant}", tenants: { acme: {} } }, {}, [], { QS_TENANCY_CONNECTION: "other-{tenant}" });
    expect((await overridden.fetch("/posts", as("acme"))).status).toBe(200);
    expect(memory.opened).toEqual(["other-acme"]);
  });

  test("the tenant's own connection wins; a function falls back to the connection service for the tenants it skips", async () => {
    mock = http.mock();
    mock.service("vault" as never).on("GET", "/tenants/globex/connection").reply(200, { connection: "from-service" });
    const { root, opened } = recordingMemory();
    const app = await start(
      root,
      {
        connection: ({ tenant }: { tenant: { plan?: string; attributes: Record<string, string> } }) => (tenant.plan === "enterprise" ? tenant.attributes.dsn : undefined),
        connectionService: "vault",
        tenants: { own: { connection: "own-store" }, initech: { plan: "enterprise", attributes: { dsn: "initech-dsn" } }, globex: { plan: "free" } },
      },
      SERVICES,
    );
    for (const tenant of ["own", "initech", "globex"]) expect((await app.fetch("/posts", as(tenant))).status).toBe(200);
    expect(opened).toEqual(["own-store", "initech-dsn", "from-service"]);
  });
});

describe("the connection service", () => {
  test("a ttl keeps the connection, so a pool reopened within it does not ask again; a 404 answers 503 and logs the miss", async () => {
    let now = 1_000_000;
    directoryClock.now = () => now;
    mock = http.mock();
    let calls = 0;
    mock.service("vault" as never).on("GET", "/tenants/acme/connection").replyWith(() => (calls++, { status: 200, body: { connection: "acme-store", ttl: 60 } }));
    mock.service("vault" as never).on("GET", "/tenants/nope/connection").reply(404, {});
    const { root, opened } = recordingMemory();
    const app = await start(root, { connectionService: "vault", pools: { idle: "10s" }, tenants: { acme: {}, nope: {}, other: { connection: "other" } } }, SERVICES);
    expect((await app.fetch("/posts", as("acme"))).status).toBe(200);
    now += 11_000;
    // The idle acme pool closes on the next request and opens again, within the 60 second ttl.
    expect((await app.fetch("/posts", as("other"))).status).toBe(200);
    expect((await app.fetch("/posts", as("acme"))).status).toBe(200);
    expect(opened.filter((connection) => connection === "acme-store")).toHaveLength(2);
    expect(calls).toBe(1);
    const missing = await app.fetch("/posts", as("nope"));
    expect(missing.status).toBe(503);
    expect(app.logs.find((entry) => entry.message === "tenancy.connection.missing")).toMatchObject({ tenant: "nope" });
  });

  test("refused credentials resolve the connection once more and open with it", async () => {
    mock = http.mock();
    let calls = 0;
    mock.service("vault" as never).on("GET", "/tenants/acme/connection").replyWith(() => ({ status: 200, body: { connection: ++calls === 1 ? "old-password" : "new-password" } }));
    const refused = Object.assign(new Error("password authentication failed"), { code: "28P01" });
    const { root, opened } = recordingMemory((connection) => (connection === "old-password" ? refused : undefined));
    const app = await start(root, { connectionService: "vault", tenants: { acme: {} } }, SERVICES);
    expect((await app.fetch("/posts", as("acme"))).status).toBe(200);
    expect(opened).toEqual(["old-password", "new-password"]);
    expect(calls).toBe(2);
  });

  test("after the ttl a changed connection opens a new pool; the old one closes once its request finishes", async () => {
    let now = 1_000_000;
    directoryClock.now = () => now;
    mock = http.mock();
    let current = "first-store";
    mock.service("vault" as never).on("GET", "/tenants/acme/connection").replyWith(() => ({ status: 200, body: { connection: current, ttl: 60 } }));
    const { root, opened } = recordingMemory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: Endpoint = async () => (await gate, { done: true });
    const app = await start(root, { connectionService: "vault", tenants: { acme: {} } }, SERVICES, [{ path: "/slow", handler: slow }]);
    const long = app.fetch("/slow", as("acme"));
    await Bun.sleep(5);
    current = "second-store";
    now += 61_000;
    // This request still uses the open pool and refreshes the connection in the background.
    expect((await app.fetch("/posts", as("acme"))).status).toBe(200);
    await Bun.sleep(5);
    expect((await app.fetch("/posts", as("acme"))).status).toBe(200);
    expect(opened).toEqual(["first-store", "second-store"]);
    expect(app.logs.some((entry) => entry.message === "tenancy.connection.changed" && entry.tenant === "acme")).toBe(true);
    expect(app.logs.some((entry) => entry.message === "tenancy.pool.closed")).toBe(false);
    release();
    expect((await long).status).toBe(200);
    await Bun.sleep(5);
    expect(app.logs.find((entry) => entry.message === "tenancy.pool.closed")).toMatchObject({ tenant: "acme", reason: "changed" });
    expect(JSON.stringify(app.logs)).not.toContain("store");
  });
});

describe("masking", () => {
  test("no log entry, response or stats holds a connection text; a function returning 42 fails naming tenancy.connection", async () => {
    const secret = "postgres://app:s3cr3t-value@127.0.0.1:1/acme";
    const { root } = recordingMemory((connection) => (connection === secret ? new Error(`could not connect to ${secret}`) : undefined));
    const app = await start(root, { connection: ({ tenant }: { tenant: { id: string } }) => (tenant.id === "acme" ? secret : 42), tenants: { acme: {}, bad: {} } });
    const failed = await app.fetch("/posts", as("acme"));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("s3cr3t");
    const invalid = await app.fetch("/posts", as("bad"));
    expect(invalid.status).toBe(503);
    expect(app.logs.some((entry) => JSON.stringify(entry).includes("Invalid tenancy.connection for tenant bad: expected a connection text or object, got a number"))).toBe(true);
    expect(JSON.stringify(app.logs)).not.toContain("s3cr3t");
  });
});
