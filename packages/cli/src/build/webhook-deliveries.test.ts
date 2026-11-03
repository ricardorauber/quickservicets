import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { events, registerProjectFeatures, runForTenant, webhooks, type EntityModel } from "@quickservicets/core";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";

afterEach(() => registerProjectFeatures([]));

const config = (keys: string, adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ database: ${adapter}, ${keys} });
`;
const ORDER = `/** @webhooks */
export type Order = {
  status: string;
  /** @sensitive */
  cardNumber?: string;
};
`;
const BASE = {
  "entities/Order.ts": ORDER,
  "entities/OrderItem.ts": 'import type { Order } from "./Order.ts";\n/** @webhooks */\nexport type OrderItem = {\n  sku: string;\n  /** @onDelete cascade */\n  order: Order;\n};\n',
  "entities/Note.ts": "export type Note = { text: string };\n",
  "endpoints/rollback/post.ts": `import { transaction, type Repositories } from "@quickservicets/core";
export default async (repos: Repositories) => transaction(async () => {
  await repos.orders.create({ status: "new" });
  throw new Error("rolled back");
});
`,
  "endpoints/invoices/[id]/pay/post.ts": `import { events, type ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest<{ size?: number }>) => {
  const body = await req.json() as { size?: number };
  await events.emit("invoice.paid" as never, { invoiceId: req.params.id, note: "x".repeat(body.size ?? 1) } as never);
  return { ok: true };
};
`,
};

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function start(keys = 'webhooks: { events: ["invoice.*"] }', extra: Record<string, string> = {}) {
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), ...BASE, ...extra } });
  running.push(service);
  return service;
}

type Delivery = { id: string; subscription: string; event: string; type: string; status: string; attempt: number; payload: { id: string; type: string; timestamp: string; data: Record<string, unknown> }; lastError?: string; tenant?: string | null };
type Message = { queue: string; payload: unknown; dedupeKey?: string };
type Repos = { webhookDeliveries: { query(): { toArray(): Promise<Delivery[]> } }; queueMessages: { query(): { toArray(): Promise<Message[]> } } };
const deliveries = async (service: TestService) => (service.repos as unknown as Repos).webhookDeliveries.query().toArray();
const messages = async (service: TestService) => (await (service.repos as unknown as Repos).queueMessages.query().toArray()).filter((message) => message.queue === "webhooks/deliver");
const send = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const subscribe = (events: string[], url = "https://hooks.example/a") => webhooks.subscriptions.create({ url, events });

describe("the WebhookDelivery entity", () => {
  test("a read-only system entity without routes; migration add creates it with its indexes", async () => {
    const service = await start();
    const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
    expect(models.find((model) => model.key === "WebhookDelivery")).toMatchObject({ system: true, name: "webhook-deliveries", tableName: "webhook_deliveries", indexes: [{ fields: ["subscription", "event"], unique: true }, { fields: ["subscription", "status"] }] });
    expect((await service.fetch("/webhook-deliveries")).status).toBe(404);
    const root = createLinkedProject({ "quickservicets.config.ts": config("webhooks: {}", 'sqliteAdapter({ path: ":memory:" })'), "entities/Order.ts": ORDER });
    const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?webhook_deliveries/);
    expect(created).toMatch(/webhook_deliveries_subscription_event/);
    expect(created).toMatch(/webhook_deliveries_subscription_status/);
  });
});

describe("matching events", () => {
  test("a write creates one pending delivery and one deliver message; a rolled-back write creates neither", async () => {
    const service = await start();
    const subscription = await subscribe(["order.created"]);
    const order = (await (await service.fetch("/orders", send("POST", { status: "new" }))).json()) as { id: string };
    const [delivery, ...others] = await deliveries(service);
    expect(others).toEqual([]);
    expect(delivery).toMatchObject({ subscription: subscription.id, type: "order.created", status: "pending", attempt: 0 });
    expect(delivery!.payload).toMatchObject({ type: "order.created", data: { entity: "Order", operation: "created", recordId: order.id } });
    expect(delivery!.payload.id).toBe(delivery!.event);
    expect(await messages(service)).toMatchObject([{ payload: delivery!.id, dedupeKey: delivery!.id }]);
    expect((await service.fetch("/rollback", send("POST", {}))).status).toBe(500);
    expect(await deliveries(service)).toHaveLength(1);
    expect(await messages(service)).toHaveLength(1);
  });

  test("every matching subscription gets one delivery, others none, an event several patterns match is handled once", async () => {
    const service = await start('webhooks: { events: ["invoice.*", "*.created"] }');
    const wide = await subscribe(["order.*"]);
    const exact = await subscribe(["order.created", "*.created"]);
    const deleted = await subscribe(["order.deleted"]);
    await service.fetch("/orders", send("POST", { status: "new" }));
    const found = await deliveries(service);
    expect(found.map((delivery) => delivery.subscription).sort()).toEqual([wide.id, exact.id].sort());
    expect(found.some((delivery) => delivery.subscription === deleted.id)).toBe(false);
  });

  test("with tenancy, an order of acme reaches only acme's subscriptions", async () => {
    const service = await start('webhooks: {}, tenancy: { source: "config", tenants: { acme: {}, globex: {} } }');
    const acme = await runForTenant("acme", () => subscribe(["order.created"]));
    await runForTenant("globex", () => subscribe(["order.created"]));
    await subscribe(["order.created"]);
    await service.fetch("/orders", send("POST", { status: "new" }, { "x-tenant-id": "acme" }));
    const found = await deliveries(service);
    expect(found.map((delivery) => [delivery.subscription, delivery.tenant])).toEqual([[acme.id, "acme"]]);
  });
});

describe("the body", () => {
  test("updates carry the record without @sensitive fields and what changed; deletes carry the record before; cascades say so", async () => {
    const service = await start();
    await subscribe(["order.updated", "order.deleted", "orderItem.deleted"]);
    const order = (await (await service.fetch("/orders", send("POST", { status: "new", cardNumber: "4242" }))).json()) as { id: string };
    await service.fetch("/order-items", send("POST", { sku: "a", order: order.id }));
    await service.fetch(`/orders/${order.id}`, send("PATCH", { status: "paid", cardNumber: "5555" }));
    await service.fetch(`/orders/${order.id}`, { method: "DELETE" });
    const byType = new Map((await deliveries(service)).map((delivery) => [delivery.type, delivery.payload]));
    const updated = byType.get("order.updated")!;
    expect(Object.keys(updated).sort()).toEqual(["data", "id", "timestamp", "type"]);
    expect(Number.isNaN(Date.parse(updated.timestamp))).toBe(false);
    expect(updated.data).toMatchObject({ entity: "Order", operation: "updated", recordId: order.id, record: { id: order.id, status: "paid" }, changed: ["status"] });
    expect(updated.data.record).not.toHaveProperty("cardNumber");
    expect(updated.data).not.toHaveProperty("cause");
    expect(byType.get("order.deleted")!.data).toMatchObject({ operation: "deleted", record: { id: order.id, status: "paid" } });
    expect(byType.get("orderItem.deleted")!.data).toMatchObject({ operation: "deleted", record: { sku: "a" }, cause: "cascade" });
  });

  test("custom events carry their payload; a payload over 256 KB makes a failed delivery and no message", async () => {
    const service = await start();
    await subscribe(["invoice.paid"]);
    await service.fetch("/invoices/i1/pay", send("POST", {}));
    const [small] = await deliveries(service);
    expect(small!.payload).toMatchObject({ type: "invoice.paid", data: { invoiceId: "i1", note: "x" } });
    expect(await messages(service)).toHaveLength(1);
    await service.fetch("/invoices/i2/pay", send("POST", { size: 300 * 1024 }));
    const large = (await deliveries(service)).find((delivery) => delivery.id !== small!.id)!;
    expect(large).toMatchObject({ status: "failed", lastError: "Payload too large", type: "invoice.paid" });
    expect(await messages(service)).toHaveLength(1);
  });
});

describe("the subscription cache", () => {
  test("a subscription created through the API is matched by the next write without waiting for the refresh", async () => {
    const service = await start();
    await service.fetch("/orders", send("POST", { status: "first" }));
    expect(await deliveries(service)).toHaveLength(0);
    await subscribe(["order.created"]);
    await service.fetch("/orders", send("POST", { status: "second" }));
    expect(await deliveries(service)).toHaveLength(1);
    const disabled = (await webhooks.subscriptions.list()).data[0]!;
    await webhooks.subscriptions.update(disabled.id, { enabled: false });
    await service.fetch("/orders", send("POST", { status: "third" }));
    expect(await deliveries(service)).toHaveLength(1);
  });

  test("writes of an entity neither tagged nor matched reach no webhook listener", async () => {
    const service = await start();
    await subscribe(["order.created"]);
    const seen: string[] = [];
    // The native listens to its patterns only: a listener on every event sees note.created, and no delivery is made.
    const stop = events.on("*", (event) => void seen.push(event.type), { phase: "inTransaction" });
    try {
      await service.fetch("/notes", send("POST", { text: "n" }));
    } finally {
      stop();
    }
    expect(seen).toEqual(["note.created"]);
    expect(await deliveries(service)).toHaveLength(0);
  });
});
