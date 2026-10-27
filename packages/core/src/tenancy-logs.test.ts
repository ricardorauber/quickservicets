import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { currentTenant } from "./database-scope.ts";
import type { ErrorReport } from "./error-reports.ts";
import { http, type HttpMock } from "./features/http/index.ts";
import { queue, queueMessageEntity } from "./features/queues/index.ts";
import { markTenancy } from "./features/tenancy/models.ts";
import type { Endpoint } from "./http/server.ts";
import { job } from "./jobs/job.ts";
import { jobRunEntity } from "./jobs/job-run.ts";
import { REQUEST_LOG } from "./logger.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";

const models = markTenancy([entity("Post", [field({ name: "title", type: "string" })]), queueMessageEntity(), jobRunEntity()]);
const TENANTS = { acme: { connection: "postgres://app:s3cret@db/acme" }, globex: {} };

const running: TestApp[] = [];
let mock: HttpMock | undefined;
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  mock?.restore();
  mock = undefined;
});

const seenTenants: unknown[] = [];
const whoami: Endpoint = () => (seenTenants.push(currentTenant()), { ok: true });
const exempt = { tenancy: { on: false, options: {} } };

async function start(extra: Record<string, unknown> = {}, options: Partial<Parameters<typeof startTestApp>[0]> = {}) {
  const app = await startTestApp({
    database: memoryAdapter(),
    models,
    config: { tenancy: { source: "config", tenants: TENANTS }, ...extra },
    endpoints: [
      { path: "/whoami", handler: whoami },
      { path: "/public", handler: whoami, tags: exempt },
    ],
    ...options,
  });
  running.push(app);
  return app;
}
const as = (tenant: string) => ({ headers: { "x-tenant-id": tenant } });
const requestEntries = (app: TestApp) => app.logs.filter((entry) => (entry as Record<symbol, unknown>)[REQUEST_LOG]);

describe("request log entries", () => {
  test("a request of acme logs tenant acme; an exempt route's entry has none", async () => {
    const app = await start();
    await app.fetch("/whoami", as("acme"));
    await app.fetch("/public");
    const [tenanted, exempted] = requestEntries(app);
    expect([tenanted?.route, tenanted?.tenant]).toEqual(["/whoami", "acme"]);
    expect([exempted?.route, "tenant" in (exempted ?? {})]).toEqual(["/public", false]);
  });
});

describe("runs, reports and outgoing calls", () => {
  test("a consumer of an acme message logs and calls services for acme; an entry that sets tenant keeps it", async () => {
    mock = http.mock();
    const sent: (string | null)[] = [];
    mock.service("billing" as never).on("GET", "/plan").replyWith(({ headers }) => (sent.push(headers.get("x-tenant-id")), { status: 200, body: {} }));
    const consumed: unknown[] = [];
    const notify = queue(async (ctx) => {
      ctx.log.info("sent");
      ctx.log.info("other", { tenant: "x" });
      consumed.push(currentTenant());
      await ctx.http.service("billing" as never).get("/plan").send();
    });
    const enqueue: Endpoint = async (_repos, req) => req.queue.add("notify" as never, {} as never);
    const app = await start(
      { queues: { pollInterval: "10ms" }, http: { services: { billing: { url: "http://billing.internal", propagate: ["tenant"] } } } },
      { endpoints: [{ method: "POST", path: "/enqueue", handler: enqueue }], featureFolders: { queues: { queues: new Map([["notify", notify]]) } } },
    );
    await app.fetch("/enqueue", { method: "POST", ...as("acme") });
    for (let tries = 0; tries < 200 && sent.length === 0; tries++) await Bun.sleep(10);
    expect(app.logs.find((entry) => entry.message === "sent")).toMatchObject({ tenant: "acme", queue: "notify" });
    expect(app.logs.find((entry) => entry.message === "other")).toMatchObject({ tenant: "x" });
    expect(consumed).toEqual([{ id: "acme" }]);
    expect(sent).toEqual(["acme"]);
  });

  test("a failing per-tenant job sends an error report naming the tenant", async () => {
    const reports: ErrorReport[] = [];
    const reportJob = job({ every: "1h" }, async (ctx) => {
      if (ctx.tenant!.id === "globex") throw new Error("globex failed");
    }, { tenants: "each" });
    const app = await start({ errors: { reporter: { report: (report: ErrorReport) => void reports.push(report) } } }, { jobs: new Map([["report", reportJob]]) });
    await app.app.jobRunner.run({ job: "report", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    for (let tries = 0; tries < 100 && !reports.some((report) => report.tenant); tries++) await Bun.sleep(10);
    expect(reports.find((report) => report.error.message === "globex failed")).toMatchObject({ kind: "job", tenant: { id: "globex" } });
  });
});

describe("tenancy entries", () => {
  test("an unknown tenant logs its id, an invalid one logs nothing of it, and no entry holds a connection", async () => {
    const app = await start();
    await app.fetch("/whoami", as("nope"));
    await app.fetch("/whoami", as("Bad Value"));
    await app.fetch("/whoami", as("acme"));
    expect(app.logs.find((entry) => entry.message === "tenancy.unknown")).toMatchObject({ tenant: "nope" });
    expect(app.logs.find((entry) => entry.message === "tenancy.resolved")).toMatchObject({ level: "debug", tenant: "acme", source: "header" });
    const text = JSON.stringify(app.logs);
    expect(text).not.toContain("Bad Value");
    expect(text).not.toContain("s3cret");
  });

  test("currentTenant() is the request's tenant, undefined on exempt routes and without tenancy", async () => {
    seenTenants.length = 0;
    const app = await start();
    await app.fetch("/whoami", as("acme"));
    await app.fetch("/public");
    expect(seenTenants).toEqual([{ id: "acme" }, undefined]);
    await app.stop();
    const plain = await startTestApp({ database: memoryAdapter(), models, endpoints: [{ path: "/whoami", handler: whoami }] });
    running.push(plain);
    await plain.fetch("/whoami");
    expect(seenTenants.at(-1)).toBeUndefined();
    expect(plain.lifecycle.server.wrapLogger).toBeUndefined();
    expect(plain.lifecycle.server.requestLogTenant).toBeUndefined();
    expect("tenant" in requestEntries(plain)[0]!).toBe(false);
  });
});
