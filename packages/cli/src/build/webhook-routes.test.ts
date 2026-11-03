import { afterEach, describe, expect, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), ${keys} });
`;
const ORDER = "/** @webhooks */\nexport type Order = { status: string };\n";

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function start(keys = "auth: {}, webhooks: {}", withAuth = true) {
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), "entities/Order.ts": ORDER }, ...(withAuth ? { auth: testAuth() } : {}) });
  running.push(service);
  return service;
}

const as = (user: string | undefined, init: RequestInit = {}, tenant?: string): RequestInit => ({
  ...init,
  headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}), ...((init.headers as Record<string, string>) ?? {}) },
});
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const errorOf = async (response: Response) => ({ status: response.status, ...((await response.json()) as { error: { code: string; message: string } }).error });
const ADMIN = "ana;roles=admin";
const SUBSCRIPTION = { url: "https://hooks.example/orders", events: ["order.created"] };

describe("registration", () => {
  test("with auth the routes exist; without auth none exists and one line says why; routes: false removes them", async () => {
    const service = await start();
    expect((await service.fetch("/webhooks", as(ADMIN))).status).toBe(200);
    const plain = await start("webhooks: {}", false);
    expect((await plain.fetch("/webhooks")).status).toBe(404);
    expect((await plain.fetch("/webhooks", post(SUBSCRIPTION))).status).toBe(404);
    const off = await start("auth: {}, webhooks: { routes: false }");
    expect((await off.fetch("/webhooks", as(ADMIN))).status).toBe(404);
    const environment = await startTestService({ files: { "quickservicets.config.ts": config("auth: {}, webhooks: {}"), "entities/Order.ts": ORDER }, auth: testAuth(), env: { QS_WEBHOOKS_ROUTES_ENABLED: "false" } });
    running.push(environment);
    expect((await environment.fetch("/webhooks", as(ADMIN))).status).toBe(404);
  });
});

describe("the log line", () => {
  test("without auth, startup logs once that the routes need authentication", async () => {
    const logs: { message: string }[] = [];
    (globalThis as unknown as { webhookRouteLogs: { message: string }[] }).webhookRouteLogs = logs;
    const keys = "webhooks: {}, logger: { info() {}, error() {}, warn: (entry) => globalThis.webhookRouteLogs.push(entry) }";
    const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), "entities/Order.ts": ORDER } });
    running.push(service);
    await service.fetch("/webhooks");
    await service.fetch("/webhooks");
    expect(logs.filter((entry) => entry.message === "webhooks.routes need authentication; enable auth or manage subscriptions with webhooks.subscriptions")).toHaveLength(1);
  });
});

describe("roles", () => {
  test("admins manage subscriptions, other users get 403, anonymous calls 401; an empty roles list lets any user", async () => {
    const service = await start();
    expect(await errorOf(await service.fetch("/webhooks", as("bob", post(SUBSCRIPTION))))).toMatchObject({ status: 403, message: "Not allowed" });
    expect(await errorOf(await service.fetch("/webhooks", as(undefined, post(SUBSCRIPTION))))).toMatchObject({ status: 401, message: "Authentication required" });
    const open = await start("auth: {}, webhooks: { routes: { roles: [] } }");
    expect((await open.fetch("/webhooks", as("bob", post(SUBSCRIPTION)))).status).toBe(201);
    expect((await open.fetch("/webhooks", as(undefined))).status).toBe(401);
  });
});

describe("managing subscriptions", () => {
  test("create answers 201 with the secret; read, list and update never show it; delete answers 204", async () => {
    const service = await start();
    const created = await service.fetch("/webhooks", as(ADMIN, post({ ...SUBSCRIPTION, description: "orders", headers: { "x-team": "ops" } })));
    expect(created.status).toBe(201);
    const subscription = (await created.json()) as { id: string; secret: string; createdBy: string };
    expect(subscription.secret).toMatch(/^whsec_/);
    expect(subscription.createdBy).toBe("ana");
    const read = (await (await service.fetch(`/webhooks/${subscription.id}`, as(ADMIN))).json()) as Record<string, unknown>;
    expect(read).toMatchObject({ id: subscription.id, url: SUBSCRIPTION.url, description: "orders", headers: { "x-team": "ops" } });
    expect(read).not.toHaveProperty("secret");
    expect(read).not.toHaveProperty("previousSecret");
    const patched = await service.fetch(`/webhooks/${subscription.id}`, as(ADMIN, { method: "PATCH", body: JSON.stringify({ enabled: false, description: "paused" }) }));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ enabled: false, description: "paused" });
    const invalid = await service.fetch("/webhooks", as(ADMIN, post({ url: "https://127.0.0.1/x", events: ["order.created"] })));
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { details: unknown } }).error.details).toEqual([{ field: "url", message: "Address is not allowed" }]);
    const deleted = await service.fetch(`/webhooks/${subscription.id}`, as(ADMIN, { method: "DELETE" }));
    expect(deleted.status).toBe(204);
    expect(await errorOf(await service.fetch(`/webhooks/${subscription.id}`, as(ADMIN)))).toMatchObject({ status: 404, message: "Webhook subscription not found" });
  });

  test("rotate-secret answers a new secret valid next to the old one for 24 hours; the list filters, pages and orders newest first", async () => {
    const service = await start();
    const ids: string[] = [];
    for (let index = 0; index < 8; index++) {
      const created = (await (await service.fetch("/webhooks", as(ADMIN, post({ ...SUBSCRIPTION, description: `s${index}` })))).json()) as { id: string };
      ids.push(created.id);
      if (index % 4 !== 0) await service.fetch(`/webhooks/${created.id}`, as(ADMIN, { method: "PATCH", body: JSON.stringify({ enabled: false }) }));
    }
    const before = Date.now();
    const rotated = await service.fetch(`/webhooks/${ids[0]}/rotate-secret`, as(ADMIN, { method: "POST" }));
    expect(rotated.status).toBe(200);
    const body = (await rotated.json()) as { secret: string; previousSecretExpiresAt: string };
    expect(body.secret).toMatch(/^whsec_/);
    expect(Math.abs(Date.parse(body.previousSecretExpiresAt) - before - 24 * 3_600_000)).toBeLessThan(5000);
    const disabled = (await (await service.fetch("/webhooks?enabled=false&limit=5", as(ADMIN))).json()) as { data: { enabled: boolean; description: string }[]; total: number; limit: number };
    expect(disabled.total).toBe(6);
    expect(disabled.limit).toBe(5);
    expect(disabled.data).toHaveLength(5);
    expect(disabled.data.every((item) => !item.enabled)).toBe(true);
    expect(disabled.data[0]!.description).toBe("s7");
    expect((await service.fetch("/webhooks?limit=101", as(ADMIN))).status).toBe(400);
  });
});

describe("tenants", () => {
  test("an admin of globex gets 404 for a subscription of acme; each tenant lists its own", async () => {
    const service = await start('auth: {}, webhooks: {}, tenancy: { source: "config", tenants: { acme: {}, globex: {} } }');
    const created = (await (await service.fetch("/webhooks", as(ADMIN, post(SUBSCRIPTION), "acme"))).json()) as { id: string; tenant: string; createdBy: string };
    expect(created).toMatchObject({ tenant: "acme", createdBy: "ana" });
    expect(await errorOf(await service.fetch(`/webhooks/${created.id}`, as(ADMIN, {}, "globex")))).toMatchObject({ status: 404, message: "Webhook subscription not found" });
    expect(((await (await service.fetch("/webhooks", as(ADMIN, {}, "globex"))).json()) as { total: number }).total).toBe(0);
    expect(((await (await service.fetch("/webhooks", as(ADMIN, {}, "acme"))).json()) as { total: number }).total).toBe(1);
  });
});

describe("the API docs", () => {
  test("/openapi.json documents the routes under the webhooks tag as needing a user with a role", async () => {
    const service = await start();
    const doc = (await (await service.fetch("/openapi.json")).json()) as { paths: Record<string, Record<string, { tags: string[]; "x-auth": unknown; responses: Record<string, unknown> }>> };
    expect(Object.keys(doc.paths["/webhooks"]!).sort()).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths["/webhooks/{id}"]!).sort()).toEqual(["delete", "get", "patch"]);
    expect(doc.paths["/webhooks/{id}/rotate-secret"]!.post!.tags).toEqual(["webhooks"]);
    expect(doc.paths["/webhooks"]!.post!["x-auth"]).toEqual({ roles: ["admin"] });
    expect(doc.paths["/webhooks"]!.post!.responses).toHaveProperty("201");
    expect(doc.paths["/webhooks"]!.post!.responses).toHaveProperty("401");
    const plain = await start("webhooks: {}", false);
    const without = (await (await plain.fetch("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(without.paths["/webhooks"]).toBeUndefined();
  });
});
