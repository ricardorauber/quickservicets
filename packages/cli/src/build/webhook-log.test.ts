import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runForTenant, sqliteAdapter, webhooks, type EntityModel, type StoredRecord } from "@quickservicets/core";
import { testAuth, useTestResolver } from "@quickservicets/core/testing";
import { runningDeliveries } from "@quickservicets/core/features/webhooks/running.ts";
import { build } from "./build.ts";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), auth: {}, queues: { consume: false }, http: { allow: ["receiver.test"] }, logger: { info() {}, warn() {}, error() {} }, ${keys} });
`;
const ORDER = "/** @webhooks */\nexport type Order = { status: string };\n";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function receiver(statuses: number[]) {
  const received: { headers: Headers; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({ headers: request.headers, body: await request.text() });
      return new Response("answer", { status: statuses[Math.min(received.length - 1, statuses.length - 1)] });
    },
  });
  cleanups.push(() => server.stop(true));
  return { received, url: `http://receiver.test:${server.port}/hook` };
}

async function start(keys = 'webhooks: { delivery: { retrySchedule: ["1s"] } }') {
  cleanups.push(useTestResolver({ "receiver.test": "127.0.0.1" }));
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), "entities/Order.ts": ORDER }, auth: testAuth() });
  cleanups.push(() => service.stop());
  return service;
}

const ADMIN = "ana;roles=admin";
const as = (init: RequestInit = {}, tenant?: string): RequestInit => ({ ...init, headers: { "content-type": "application/json", "x-test-user": ADMIN, ...(tenant ? { "x-tenant-id": tenant } : {}) } });
const deliver = (id: string) => runningDeliveries().deliver(id, { signal: new AbortController().signal });
type Delivery = { id: string; status: string; type: string; attempt: number; lastStatus?: number; lastError?: string; payload?: unknown; event: string };
const all = async (service: TestService) => (service.repos as unknown as { webhookDeliveries: { query(): { toArray(): Promise<Delivery[]> } } }).webhookDeliveries.query().toArray();
const createOrder = (service: TestService, status: string, tenant?: string) => service.fetch("/orders", { method: "POST", headers: { "content-type": "application/json", ...(tenant ? { "x-tenant-id": tenant } : {}) }, body: JSON.stringify({ status }) });

describe("the delivery log", () => {
  test("lists a subscription's deliveries with status and type filters, and the detail shows the body that was sent", async () => {
    const target = receiver([200, 500, 500, 500, 500]);
    const service = await start();
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.*"] });
    for (const status of ["a", "b", "c"]) await createOrder(service, status);
    // The first succeeds; the others fail twice, the schedule's single retry included.
    const rows = (await all(service)).sort((a, b) => a.id.localeCompare(b.id));
    for (const row of rows) {
      await deliver(row.id);
      await deliver(row.id);
    }
    const failed = (await (await service.fetch(`/webhooks/${subscription.id}/deliveries?status=failed`, as())).json()) as { data: Delivery[]; total: number };
    expect(failed.total).toBe(2);
    expect(failed.data.every((row) => row.status === "failed" && row.lastStatus === 500 && row.lastError === "500 Internal Server Error")).toBe(true);
    expect(failed.data[0]).not.toHaveProperty("payload");
    const typed = (await (await service.fetch(`/webhooks/${subscription.id}/deliveries?type=order.created&limit=2`, as())).json()) as { data: Delivery[]; total: number; limit: number };
    expect([typed.total, typed.limit, typed.data.length]).toEqual([3, 2, 2]);
    const detail = (await (await service.fetch(`/webhooks/${subscription.id}/deliveries/${rows[0]!.id}`, as())).json()) as Delivery & { lastResponse: string };
    expect(detail).toMatchObject({ id: rows[0]!.id, status: "succeeded", lastResponse: "answer" });
    expect(JSON.stringify(detail.payload)).toBe(target.received[0]!.body);
    expect((await service.fetch(`/webhooks/${subscription.id}/deliveries?status=nope`, as())).status).toBe(400);
    expect((await service.fetch(`/webhooks/${subscription.id}/deliveries/nope`, as())).status).toBe(404);
  });
});

describe("resending", () => {
  test("a failed delivery is sent again with the same webhook-id and ends succeeded with attempt 1", async () => {
    const target = receiver([500, 500, 200]);
    const service = await start();
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await createOrder(service, "a");
    const [delivery] = await all(service);
    await deliver(delivery!.id);
    await deliver(delivery!.id);
    expect((await all(service))[0]).toMatchObject({ status: "failed", attempt: 2 });
    const response = await service.fetch(`/webhooks/${subscription.id}/deliveries/${delivery!.id}/resend`, as({ method: "POST" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: delivery!.id, status: "pending" });
    expect((await all(service))[0]).toMatchObject({ status: "pending", attempt: 0 });
    await deliver(delivery!.id);
    expect((await all(service))[0]).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(new Set(target.received.map((request) => request.headers.get("webhook-id")))).toEqual(new Set([delivery!.event]));
  });

  test("a pending delivery answers 409, a disabled subscription 409, and the 31st resend in a minute 429", async () => {
    const target = receiver([200]);
    const service = await start();
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await createOrder(service, "a");
    const [delivery] = await all(service);
    const resend = () => service.fetch(`/webhooks/${subscription.id}/deliveries/${delivery!.id}/resend`, as({ method: "POST" }));
    const pending = await resend();
    expect(pending.status).toBe(409);
    expect(((await pending.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "CONFLICT", message: "Delivery is already scheduled" });
    await deliver(delivery!.id);
    await webhooks.subscriptions.update(subscription.id, { enabled: false });
    const disabled = await resend();
    expect(disabled.status).toBe(409);
    expect(((await disabled.json()) as { error: { message: string } }).error.message).toBe("Subscription is disabled");
    await expect(webhooks.resend(delivery!.id)).rejects.toThrow("Subscription is disabled");
    for (let index = 2; index < 30; index++) expect((await resend()).status).toBe(409);
    const limited = await resend();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { message: string } }).error.message).toBe("Too many requests");
  });

  test("with tenancy, an admin of globex gets 404 for a delivery of acme", async () => {
    const target = receiver([200]);
    const service = await start('webhooks: {}, tenancy: { source: "config", tenants: { acme: {}, globex: {} } }');
    const subscription = await runForTenant("acme", () => webhooks.subscriptions.create({ url: target.url, events: ["order.created"] }));
    await createOrder(service, "a", "acme");
    const [delivery] = await all(service);
    expect((await service.fetch(`/webhooks/${subscription.id}/deliveries/${delivery!.id}`, as({}, "globex"))).status).toBe(404);
    expect((await service.fetch(`/webhooks/${subscription.id}/deliveries`, as({}, "globex"))).status).toBe(404);
    expect((await service.fetch(`/webhooks/${subscription.id}/deliveries/${delivery!.id}`, as({}, "acme"))).status).toBe(200);
    await expect(runForTenant("globex", () => webhooks.resend(delivery!.id))).rejects.toThrow(`Webhook delivery ${delivery!.id} not found`);
  });

  test("/openapi.json documents the delivery log and resend routes", async () => {
    const service = await start();
    const doc = (await (await service.fetch("/openapi.json")).json()) as { paths: Record<string, Record<string, { tags: string[] }>> };
    expect(doc.paths["/webhooks/{id}/deliveries"]!.get!.tags).toEqual(["webhooks"]);
    expect(doc.paths["/webhooks/{id}/deliveries/{deliveryId}"]!.get).toBeDefined();
    expect(doc.paths["/webhooks/{id}/deliveries/{deliveryId}/resend"]!.post).toBeDefined();
  });
});

describe("the CLI", () => {
  test("webhooks list prints hosts and counts, deliveries lists them, resend --failed reschedules, an unknown delivery exits 1", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": "", "entities/Order.ts": ORDER });
    const path = join(root, "data.db");
    writeFileSync(join(root, "quickservicets.config.ts"), `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }), webhooks: {}, logger: { info() {}, warn() {}, error() {} } });\n`);
    await build(root);
    await addMigration(root, "Initial", new Date(Date.UTC(2026, 10, 3)));
    await migrate(root);
    const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
    const subscriptionModel = models.find((model) => model.key === "WebhookSubscription")!;
    const deliveryModel = models.find((model) => model.key === "WebhookDelivery")!;
    const adapter = sqliteAdapter({ path });
    await adapter.connect(models);
    const at = new Date();
    const subscription = Bun.randomUUIDv7();
    const failedIds = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    try {
      await adapter.insert(subscriptionModel, { id: subscription, createdAt: at, updatedAt: at, url: "https://hooks.example/a?token=secret", events: ["order.created"], secret: "whsec_x", enabled: true, tenant: "acme" } as StoredRecord);
      for (const [id, status] of [[failedIds[0], "failed"], [failedIds[1], "failed"], [Bun.randomUUIDv7(), "succeeded"]] as const) {
        await adapter.insert(deliveryModel, { id: id!, createdAt: at, updatedAt: at, subscription, event: Bun.randomUUIDv7(), type: "order.created", payload: {}, status, attempt: 1, lastStatus: status === "failed" ? 500 : 200 } as StoredRecord);
      }
    } finally {
      await adapter.disconnect();
    }
    const cli = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
      return { code, out, err };
    };
    const listed = await cli("webhooks", "list");
    expect(listed.code).toBe(0);
    expect(listed.out).toHaveLength(1);
    expect(listed.out[0]).toContain(`${subscription} hooks.example enabled tenant=acme failingSince=-`);
    expect(listed.out[0]).toContain("failed=2");
    expect(listed.out[0]).toContain("succeeded=1");
    expect(listed.out[0]).not.toContain("token");
    const failed = await cli("webhooks", "deliveries", subscription, "--status", "failed");
    expect(failed.code).toBe(0);
    expect(failed.out).toHaveLength(2);
    expect(await cli("webhooks", "resend", "--subscription", subscription, "--failed")).toEqual({ code: 0, out: ["Rescheduled 2 deliveries"], err: [] });
    expect(await cli("webhooks", "resend", failedIds[0]!)).toMatchObject({ code: 1, err: ["Delivery is already scheduled"] });
    expect(await cli("webhooks", "resend", "nope")).toMatchObject({ code: 1, err: ["Webhook delivery nope not found"] });
    const check = sqliteAdapter({ path });
    await check.connect(models);
    try {
      const rows = (await check.findMany(deliveryModel, { where: [], sort: [], limit: 10, offset: 0 })).data;
      expect(rows.filter((row) => row.status === "pending")).toHaveLength(2);
      const messages = (await check.findMany(models.find((model) => model.key === "QueueMessage")!, { where: [], sort: [], limit: 10, offset: 0 })).data;
      expect(messages.map((row) => row.queue)).toEqual(["webhooks/deliver", "webhooks/deliver"]);
    } finally {
      await check.disconnect();
    }
  });
});
