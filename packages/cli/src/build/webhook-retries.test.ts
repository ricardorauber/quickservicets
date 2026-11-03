import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { events, sqliteAdapter, webhookClock, webhooks, type EntityModel, type StoredRecord } from "@quickservicets/core";
import { useTestResolver } from "@quickservicets/core/testing";
import { runningDeliveries } from "@quickservicets/core/features/webhooks/running.ts";
import { build } from "./build.ts";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), queues: { consume: false }, http: { allow: ["receiver.test"] }, logger: { info() {}, warn() {}, error() {} }, ${keys} });
`;
const ORDER = "/** @webhooks */\nexport type Order = { status: string };\n";
const SECOND = 1000;
const DAY = 86_400_000;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A receiver answering each request with the next status of `statuses` (the last one repeats). */
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

/** A service whose consumers do not run, with a fake clock the test moves; `deliver` runs one attempt. */
async function start(keys = "webhooks: {}", env: Record<string, string> = {}) {
  cleanups.push(useTestResolver({ "receiver.test": "127.0.0.1" }));
  const clock = { now: Date.parse("2026-11-03T10:00:00Z") };
  const original = webhookClock.now;
  webhookClock.now = () => clock.now;
  cleanups.push(() => (webhookClock.now = original));
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), "entities/Order.ts": ORDER }, env });
  cleanups.push(() => service.stop());
  const deliver = (id: string) => runningDeliveries().deliver(id, { signal: new AbortController().signal });
  return { service, clock, deliver };
}

type Delivery = { id: string; subscription: string; status: string; attempt: number; nextAttemptAt?: Date | null; lastStatus?: number; lastError?: string; type: string };
type Repos = {
  webhookDeliveries: { query(): { toArray(): Promise<Delivery[]> }; findById(id: string): Promise<Delivery> };
  queueMessages: { query(): { toArray(): Promise<{ queue: string; payload: unknown; runAt: Date; dedupeKey?: string }[]> } };
  webhookSubscriptions: { update(id: string, changes: object): Promise<unknown>; findById(id: string): Promise<{ failingSince?: Date | null; enabled: boolean; disabledReason?: string | null }> };
};
const repos = (service: TestService) => service.repos as unknown as Repos;
const createOrder = (service: TestService, status = "new") => service.fetch("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
const only = async (service: TestService) => (await repos(service).webhookDeliveries.query().toArray())[0]!;

describe("retries", () => {
  test("a receiver failing twice then answering 200 sees attempts at about 0, 5 seconds and 5 minutes 5 seconds", async () => {
    const target = receiver([500, 503, 200]);
    const { service, clock, deliver } = await start();
    await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await createOrder(service);
    const started = clock.now;
    const delivery = await only(service);
    const times: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      times.push(clock.now - started);
      await deliver(delivery.id);
      const current = await repos(service).webhookDeliveries.findById(delivery.id);
      if (attempt < 3) {
        expect(current).toMatchObject({ status: "pending", attempt });
        const messages = (await repos(service).queueMessages.query().toArray()).filter((message) => message.dedupeKey === `${delivery.id}:${attempt}`);
        expect(messages).toHaveLength(1);
        expect(new Date(messages[0]!.runAt).getTime()).toBe(new Date(current.nextAttemptAt!).getTime());
        clock.now = new Date(current.nextAttemptAt!).getTime();
      } else expect(current).toMatchObject({ status: "succeeded", attempt: 3, lastStatus: 200 });
    }
    expect(times[0]).toBe(0);
    expect(times[1]).toBeGreaterThanOrEqual(4.5 * SECOND);
    expect(times[1]).toBeLessThanOrEqual(5.5 * SECOND);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(270 * SECOND);
    expect(times[2]! - times[1]!).toBeLessThanOrEqual(330 * SECOND);
    // Every attempt carries the same webhook-id.
    expect(new Set(target.received.map((request) => request.headers.get("webhook-id"))).size).toBe(1);
  });

  test("after the last attempt the delivery is failed with its last status, and webhook.delivery.failed is emitted once", async () => {
    const target = receiver([500]);
    const { service, clock, deliver } = await start('webhooks: { delivery: { retrySchedule: ["1s"] } }');
    const failed: unknown[] = [];
    const succeeded: unknown[] = [];
    cleanups.push(events.on("webhook.delivery.failed", (event) => void failed.push(event.payload)));
    cleanups.push(events.on("webhook.delivery.succeeded", (event) => void succeeded.push(event.payload)));
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await createOrder(service);
    const delivery = await only(service);
    await deliver(delivery.id);
    clock.now += 2 * SECOND;
    await deliver(delivery.id);
    expect(await repos(service).webhookDeliveries.findById(delivery.id)).toMatchObject({ status: "failed", attempt: 2, lastStatus: 500, lastError: "500 Internal Server Error" });
    await events.idle();
    expect(failed).toEqual([{ subscriptionId: subscription.id, deliveryId: delivery.id, eventId: expect.any(String), type: "order.created", attempt: 2, status: 500 }]);
    expect(succeeded).toEqual([]);
    expect(target.received).toHaveLength(2);
  });
});

describe("auto-disable", () => {
  test("a subscription failing for six days is disabled at the next failure, its pending deliveries fail, and listeners are told", async () => {
    const target = receiver([500]);
    const { service, clock, deliver } = await start();
    const disabled: unknown[] = [];
    cleanups.push(events.on("webhook.subscription.disabled", (event) => void disabled.push(event.payload)));
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await createOrder(service, "a");
    await createOrder(service, "b");
    const [first, second] = (await repos(service).webhookDeliveries.query().toArray()).sort((a, b) => a.id.localeCompare(b.id));
    await deliver(first!.id);
    expect((await repos(service).webhookSubscriptions.findById(subscription.id)).failingSince).toBeDefined();
    clock.now += 6 * DAY;
    await deliver(first!.id);
    expect(await webhooks.subscriptions.get(subscription.id)).toMatchObject({ enabled: false, disabledReason: "Failing for more than 5d" });
    expect(await repos(service).webhookDeliveries.findById(first!.id)).toMatchObject({ status: "failed" });
    expect(await repos(service).webhookDeliveries.findById(second!.id)).toMatchObject({ status: "failed", lastError: "Subscription disabled" });
    await events.idle();
    expect(disabled).toEqual([{ subscriptionId: subscription.id, reason: "Failing for more than 5d" }]);
  });

  test("a success clears failingSince; QS_WEBHOOKS_DELIVERY_DISABLE_AFTER=1h disables after an hour of failures", async () => {
    const target = receiver([500, 200, 500]);
    const { service, clock, deliver } = await start("webhooks: {}", { QS_WEBHOOKS_DELIVERY_DISABLE_AFTER: "1h" });
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await createOrder(service);
    const delivery = await only(service);
    await deliver(delivery.id);
    expect((await repos(service).webhookSubscriptions.findById(subscription.id)).failingSince).toBeTruthy();
    clock.now += 10 * SECOND;
    await deliver(delivery.id);
    expect((await repos(service).webhookSubscriptions.findById(subscription.id)).failingSince).toBeNull();
    await createOrder(service, "later");
    const later = (await repos(service).webhookDeliveries.query().toArray()).find((row) => row.id !== delivery.id)!;
    await deliver(later.id);
    clock.now += 2 * 3_600_000;
    await deliver(later.id);
    expect(await webhooks.subscriptions.get(subscription.id)).toMatchObject({ enabled: false, disabledReason: "Failing for more than 1h" });
  });
});

describe("the native's own events", () => {
  test("webhook events are never delivered, even to a subscription for every event", async () => {
    const target = receiver([500]);
    const { service, deliver } = await start('webhooks: { events: ["*"], delivery: { retrySchedule: ["1s"] } }');
    await webhooks.subscriptions.create({ url: target.url, events: ["*"] });
    await createOrder(service);
    const delivery = await only(service);
    await deliver(delivery.id);
    await deliver(delivery.id);
    await events.idle();
    const types = (await repos(service).webhookDeliveries.query().toArray()).map((row) => row.type);
    expect(types).toEqual(["order.created"]);
  });
});

describe("shutdown during an attempt", () => {
  function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    return port;
  }

  test("SIGTERM leaves the delivery delivering, and the next process sends it again with the same webhook-id and attempt", async () => {
    const received: { id: string | null; at: number }[] = [];
    let slow = true;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        received.push({ id: request.headers.get("webhook-id"), at: Date.now() });
        if (slow) await Bun.sleep(5000);
        return new Response("ok");
      },
    });
    cleanups.push(() => server.stop(true));
    const root = createLinkedProject({ "quickservicets.config.ts": "", "entities/Order.ts": ORDER });
    const path = join(root, "data.db");
    writeFileSync(
      join(root, "quickservicets.config.ts"),
      `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }), webhooks: {}, queues: { pollInterval: "50ms" }, jobs: { shutdownGrace: "300ms" }, http: { allow: ["127.0.0.1"] } });\n`,
    );
    await build(root);
    await addMigration(root, "Initial", new Date(Date.UTC(2026, 10, 3)));
    await migrate(root);
    const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
    const withAdapter = async <T>(fn: (adapter: ReturnType<typeof sqliteAdapter>) => Promise<T>) => {
      const adapter = sqliteAdapter({ path });
      await adapter.connect(models);
      try {
        return await fn(adapter);
      } finally {
        await adapter.disconnect();
      }
    };
    const subscriptionModel = models.find((model) => model.key === "WebhookSubscription")!;
    const deliveryModel = models.find((model) => model.key === "WebhookDelivery")!;
    const at = new Date();
    await withAdapter((adapter) => adapter.insert(subscriptionModel, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, url: `http://127.0.0.1:${server.port}/hook`, events: ["order.created"], secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", enabled: true } as StoredRecord));
    const serve = () => {
      const port = freePort();
      const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], { cwd: root, env: { ...process.env, NODE_ENV: "development", PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
      cleanups.push(() => child.kill("SIGKILL"));
      return { child, port };
    };
    const waitFor = async (check: () => boolean, ms = 20_000) => {
      const deadline = Date.now() + ms;
      while (!check()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await Bun.sleep(25);
      }
    };
    const first = serve();
    let ready = false;
    for (let index = 0; index < 400 && !ready; index++) {
      ready = await fetch(`http://localhost:${first.port}/orders`).then((response) => response.ok, () => false);
      if (!ready) await Bun.sleep(25);
    }
    await fetch(`http://localhost:${first.port}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "new" }) });
    await waitFor(() => received.length === 1);
    first.child.kill("SIGTERM");
    await first.child.exited;
    const [left] = (await withAdapter((adapter) => adapter.findMany(deliveryModel, { where: [], sort: [], limit: 10, offset: 0 }))).data as unknown as Delivery[];
    expect(left).toMatchObject({ status: "delivering", attempt: 1 });
    slow = false;
    const second = serve();
    await waitFor(() => received.length === 2);
    expect(received[1]!.id).toBe(received[0]!.id);
    let done: Delivery | undefined;
    for (let index = 0; index < 400; index++) {
      done = ((await withAdapter((adapter) => adapter.findMany(deliveryModel, { where: [], sort: [], limit: 10, offset: 0 }))).data as unknown as Delivery[])[0];
      if (done?.status === "succeeded") break;
      await Bun.sleep(25);
    }
    expect(done).toMatchObject({ status: "succeeded", attempt: 1 });
    second.child.kill("SIGTERM");
    await second.child.exited;
  }, 60_000);
});
