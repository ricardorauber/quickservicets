import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { currentDatabaseScope } from "./database-scope.ts";
import type { AnyEvent, WriteEvent } from "./event-types.ts";
import { events } from "./features/events/index.ts";
import { outboxDeliveryEntity } from "./features/events/delivery.ts";
import { outboxEventEntity } from "./features/events/outbox.ts";
import { listen } from "./features/events/listen.ts";
import { queue, queueMessageEntity } from "./features/queues/index.ts";
import { parseChangeQuery } from "./features/realtime/changes.ts";
import { followChanges } from "./features/realtime/follow.ts";
import type { ChangeSource } from "./features/realtime/source.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import type { Endpoint } from "./http/server.ts";
import { job } from "./jobs/job.ts";
import { jobRunEntity } from "./jobs/job-run.ts";
import type { Repository, RepositoryRegistry } from "./repository.ts";
import { runForTenant } from "./tenant-runs.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import { idempotencyKeyEntity } from "./features/idempotency/store.ts";

const post = entity("Post", [field({ name: "title", type: "string" })]);
const note = entity("Note", [field({ name: "text", type: "string" })]);
const report = entity("Report", [field({ name: "line", type: "string" })]);
const delivery = entity("Email", [field({ name: "to", type: "string" })]);
const models = markTenancy([post, note, report, delivery, queueMessageEntity(), outboxEventEntity(), outboxDeliveryEntity(), jobRunEntity(), idempotencyKeyEntity()]);
const TENANTS = { acme: {}, globex: {}, initech: {}, old: { status: "suspended" } };

const running: TestApp[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
});

const repo = (repos: RepositoryRegistry, key: string) => repos[key] as Repository;
const titles = async (repos: RepositoryRegistry, key: string, field: string) =>
  (await repo(repos, key).list({ where: [], sort: [], limit: 50, offset: 0 })).data.map((record) => record[field]);

async function start(options: { config?: Record<string, unknown>; endpoints?: NonNullable<Parameters<typeof startTestApp>[0]>["endpoints"]; jobs?: Map<string, ReturnType<typeof job>>; folders?: Record<string, Record<string, ReadonlyMap<string, unknown>>>; database?: DatabaseAdapter } = {}) {
  const app = await startTestApp({
    database: options.database ?? memoryAdapter(),
    models,
    config: { tenancy: { source: "config", tenants: TENANTS }, ...(options.config ?? {}) },
    ...(options.endpoints ? { endpoints: options.endpoints } : {}),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.folders ? { featureFolders: options.folders } : {}),
  });
  running.push(app);
  return app;
}
const as = (tenant: string, init: RequestInit = {}) => ({ ...init, headers: { "x-tenant-id": tenant, ...((init.headers as Record<string, string>) ?? {}) } });
const create = (tenant: string, path: string, body: unknown) => [path, as(tenant, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })] as const;

describe("runForTenant", () => {
  test("runs in the tenant's scope, refusing unknown and suspended tenants", async () => {
    const app = await start();
    await app.fetch(...create("acme", "/posts", { title: "acme's" }));
    await app.fetch(...create("globex", "/posts", { title: "globex's" }));
    expect(await runForTenant("acme", ({ repos, tenant }) => (expect(tenant.id).toBe("acme"), titles(repos, "posts", "title")))).toEqual(["acme's"]);
    expect(await runForTenant("globex", () => currentDatabaseScope().key)).toBe("tenant:globex");
    await expect(runForTenant("nope", () => 1)).rejects.toThrow("Unknown tenant nope");
    await expect(runForTenant("old", () => 1)).rejects.toThrow("Tenant old is suspended");
  });
});

describe("jobs for each tenant", () => {
  test("one closure per active tenant, a failing one recorded while the others go on; a run for one tenant only", async () => {
    const seen: string[] = [];
    const reportJob = job(
      { every: "1h" },
      async (ctx) => {
        seen.push(ctx.tenant!.id);
        if (ctx.tenant!.id === "globex") throw new Error("globex is broken");
        await repo(ctx.repos as unknown as RepositoryRegistry, "reports").create({ line: `report of ${ctx.tenant!.id}` });
      },
      { tenants: "each", tenantConcurrency: 2 },
    );
    const plain = job({ every: "1h" }, async (ctx) => repo(ctx.repos as unknown as RepositoryRegistry, "posts").list({ where: [], sort: [], limit: 1, offset: 0 }));
    const app = await start({ jobs: new Map([["report", reportJob], ["plain", plain]]) });
    const run = await app.app.jobRunner.run({ job: "report", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    expect([run?.status, run?.result]).toEqual(["failed", { tenants: 3, failed: ["globex"] }]);
    expect(seen.sort()).toEqual(["acme", "globex", "initech"]);
    expect(await runForTenant("acme", ({ repos }) => titles(repos, "reports", "line"))).toEqual(["report of acme"]);
    expect(await runForTenant("initech", ({ repos }) => titles(repos, "reports", "line"))).toEqual(["report of initech"]);
    seen.length = 0;
    const one = await app.app.jobRunner.run({ job: "report", trigger: "manual", scheduledAt: new Date(Date.now() + 1), attempt: 1, tenant: "acme" });
    expect([one?.status, one?.result, seen]).toEqual(["success", { tenants: 1, failed: [] }, ["acme"]]);
    const failed = await app.app.jobRunner.run({ job: "plain", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    expect(failed?.error?.message).toBe("Post holds tenant data; run this for a tenant or tag the entity @tenancy shared");
  });
});

describe("queue messages", () => {
  test("a message added for acme is stored with its tenant and consumed in acme's scope; a suspended tenant's message fails and retries", async () => {
    const consumed: string[] = [];
    const send = queue(async (ctx) => {
      consumed.push(ctx.tenant!.id);
      await repo(ctx.repos as unknown as RepositoryRegistry, "emails").create({ to: String((ctx.payload as { to: string }).to) });
    });
    const enqueue: Endpoint = async (_repos, req) => req.queue.add("send-email" as never, { to: "a@x.test" } as never);
    const app = await start({
      config: { queues: { pollInterval: "10ms", retryDelay: "1h" } },
      endpoints: [{ method: "POST", path: "/enqueue", handler: enqueue }],
      folders: { queues: { queues: new Map([["send-email", send]]) } },
    });
    expect((await app.fetch("/enqueue", as("acme", { method: "POST" }))).status).toBe(200);
    const messages = queueMessageEntity();
    const stored = () => app.database.findMany(messages, { where: [], sort: [], limit: 10, offset: 0 }).then((result) => result.data);
    for (let tries = 0; tries < 200 && (await stored())[0]?.status !== "completed"; tries++) await Bun.sleep(10);
    expect((await stored())[0]).toMatchObject({ tenant: "acme", status: "completed" });
    expect(await runForTenant("acme", ({ repos }) => titles(repos, "emails", "to"))).toEqual(["a@x.test"]);
    expect(await runForTenant("globex", ({ repos }) => titles(repos, "emails", "to"))).toEqual([]);
    // A message of a tenant suspended meanwhile fails its attempt and waits for a retry.
    const at = new Date();
    await app.database.insert(messages, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, queue: "send-email", payload: { to: "b@x.test" }, status: "waiting", priority: 0, runAt: at, attempt: 0, maxAttempts: 3, enqueuedAt: at, tenant: "old" });
    let old: Record<string, unknown> | undefined;
    for (let tries = 0; tries < 200 && !old?.lastError; tries++) {
      await Bun.sleep(10);
      old = (await stored()).find((row) => row.tenant === "old");
    }
    expect(old).toMatchObject({ status: "waiting", attempt: 1, lastError: expect.objectContaining({ message: "Tenant old is suspended" }) });
  });
});

describe("events", () => {
  test("events carry the tenant; listener files and outbox deliveries run in its scope", async () => {
    const scopes: string[] = [];
    const listener = listen("post.created", async (event, { repos }) => {
      await repo(repos as unknown as RepositoryRegistry, "notes").create({ text: `about ${(event as WriteEvent).recordId}` });
    });
    const seen: AnyEvent[] = [];
    const app = await start({ config: { events: { outbox: { dispatch: true, delivery: { pollInterval: "10ms" } } } }, folders: { events: { events: new Map([["notes", listener]]) } } });
    events.on("post.created", (event) => void seen.push(event));
    events.on("invoice.paid" as never, (event: AnyEvent) => void seen.push(event));
    events.deliver("audit", { pattern: "post.created", handler: async () => void scopes.push(currentDatabaseScope().key) });
    expect((await app.fetch(...create("acme", "/posts", { title: "hello" }))).status).toBe(201);
    await events.idle();
    for (let tries = 0; tries < 200 && scopes.length === 0; tries++) await Bun.sleep(10);
    expect(seen[0]?.actor.tenant).toBe("acme");
    expect(await runForTenant("acme", ({ repos }) => titles(repos, "notes", "text"))).toHaveLength(1);
    expect(await runForTenant("globex", ({ repos }) => titles(repos, "notes", "text"))).toEqual([]);
    expect(scopes).toEqual(["tenant:acme"]);
    // An event emitted by code running for a tenant outside a request carries it too.
    await runForTenant("globex", () => events.emit("invoice.paid" as never, {} as never));
    await events.idle();
    expect(seen.find((event) => event.type === "invoice.paid")?.actor.tenant).toBe("globex");
  });
});

describe("change streams", () => {
  test("a stream of a tenant gets only that tenant's events, live and replayed; one without a tenant only untenanted ones", async () => {
    const at = new Date();
    const made = (id: string, tenant?: string) =>
      ({ id, type: "post.created", entity: "Post", operation: "created", recordId: id, before: null, after: { id, createdAt: at, updatedAt: at, title: id }, changed: [], cause: "write", actor: tenant ? { tenant } : {}, at }) as unknown as WriteEvent;
    const history = [made("01a00000-0000-7000-8000-000000000001", "acme"), made("01a00000-0000-7000-8000-000000000002", "globex"), made("01a00000-0000-7000-8000-000000000003")];
    const listeners: ((event: WriteEvent) => void)[] = [];
    const source: ChangeSource = { subscribe: (_entities, listener) => (listeners.push(listener), () => {}), replay: async () => history.slice(1) };
    const query = parseChangeQuery(post, new URLSearchParams(""), [post]);
    const follow = async (tenant: string | null) => {
      const sent: string[] = [];
      const stream = { send: (data: unknown) => void sent.push((data as { id?: string }).id ?? "reset"), signal: new AbortController().signal } as never;
      await followChanges(stream, { entity: post, query, source, tenant, lastEventId: history[0]!.id });
      return sent;
    };
    const acme = await follow("acme");
    const globex = await follow("globex");
    const untenanted = await follow(null);
    expect([acme, globex, untenanted]).toEqual([[], [history[1]!.id], [history[2]!.id]]);
  });
});

describe("idempotency keys", () => {
  test("one key used by two tenants creates one record in each", async () => {
    const app = await start({ config: { idempotency: {} } });
    const call = (tenant: string) => app.fetch("/posts", as(tenant, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "same-key" }, body: JSON.stringify({ title: `by ${tenant}` }) }));
    expect((await call("acme")).status).toBe(201);
    const second = await call("globex");
    expect([second.status, second.headers.get("idempotent-replayed")]).toEqual([201, null]);
    expect(await runForTenant("acme", ({ repos }) => titles(repos, "posts", "title"))).toEqual(["by acme"]);
    expect(await runForTenant("globex", ({ repos }) => titles(repos, "posts", "title"))).toEqual(["by globex"]);
  });
});
