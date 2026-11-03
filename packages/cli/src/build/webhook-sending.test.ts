import { afterEach, describe, expect, test } from "bun:test";
import { verifyWebhook, webhooks } from "@quickservicets/core";
import { testAuth, useTestResolver } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (keys: string, queues = 'pollInterval: "20ms", concurrency: 10') => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  queues: { ${queues} },
  http: { allow: ["receiver.test"] },
  logger: { info: (entry) => globalThis.webhookSendLogs?.push(entry), warn: (entry) => globalThis.webhookSendLogs?.push(entry), error() {} },
  ${keys}
});
`;
const ORDER = "/** @webhooks */\nexport type Order = { status: string };\n";

type Received = { headers: Headers; body: string; at: number };
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A local receiver answering with `answer`, reached as http://receiver.test:<port>. */
function receiver(answer: (request: Request, received: Received[]) => Response | Promise<Response> = () => new Response("ok")) {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const entry = { headers: request.headers, body: await request.text(), at: Date.now() };
      received.push(entry);
      return answer(request, received);
    },
  });
  cleanups.push(() => server.stop(true));
  return { received, url: `http://receiver.test:${server.port}/hook` };
}

async function start(keys = "webhooks: {}", withAuth = false, queues?: string) {
  const logs: { message: string; [key: string]: unknown }[] = [];
  (globalThis as unknown as { webhookSendLogs: unknown[] }).webhookSendLogs = logs;
  cleanups.push(useTestResolver({ "receiver.test": "127.0.0.1" }));
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys, queues), "entities/Order.ts": ORDER }, ...(withAuth ? { auth: testAuth() } : {}) });
  cleanups.push(() => service.stop());
  return { service, logs };
}

type Delivery = { id: string; status: string; attempt: number; lastStatus?: number; lastError?: string; lastResponse?: string; durationMs?: number; deliveredAt?: Date; event: string };
const deliveries = async (service: TestService) => (service.repos as unknown as { webhookDeliveries: { query(): { toArray(): Promise<Delivery[]> } } }).webhookDeliveries.query().toArray();
const createOrder = (service: TestService, status = "new") => service.fetch("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });

/** Waits until `check` holds, up to `ms`. */
async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}
const finished = (service: TestService, count = 1) => until(async () => {
  const all = await deliveries(service);
  return all.filter((delivery) => delivery.status === "succeeded" || delivery.status === "failed").length >= count ? all : undefined;
});

describe("signing", () => {
  test("signWebhook matches the Standard Webhooks test vector, and verifyWebhook accepts it and rejects a changed body", async () => {
    const { signWebhook } = await import("@quickservicets/core");
    const input = { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: 1614265330, body: '{"test": 2432232314}', secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" };
    const signature = signWebhook(input);
    expect(signature).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
    expect(verifyWebhook({ ...input, signature, secrets: [input.secret] })).toBe(true);
    expect(verifyWebhook({ ...input, signature: `v1,bogus ${signature}`, secrets: ["whsec_b3RoZXI=", input.secret] })).toBe(true);
    expect(verifyWebhook({ ...input, body: '{"test": 1}', signature, secrets: [input.secret] })).toBe(false);
    expect(verifyWebhook({ ...input, signature: "v2,abc", secrets: [input.secret] })).toBe(false);
  });
});

describe("sending a delivery", () => {
  test("a 200 answer ends succeeded; the receiver sees the signed headers and the subscription's own header, which never replaces them", async () => {
    const target = receiver();
    const { service, logs } = await start();
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"], headers: { "x-team": "ops", "webhook-id": "forged" } });
    await createOrder(service);
    const [delivery] = await finished(service);
    expect(delivery).toMatchObject({ status: "succeeded", attempt: 1, lastStatus: 200, lastResponse: "ok" });
    expect(delivery!.deliveredAt).toBeDefined();
    const [request] = target.received;
    expect(request!.headers.get("content-type")).toBe("application/json");
    expect(request!.headers.get("user-agent")).toMatch(/^quickservicets-webhooks\/\d+\.\d+\.\d+/);
    expect(request!.headers.get("webhook-id")).toBe(delivery!.event);
    expect(request!.headers.get("x-team")).toBe("ops");
    const timestamp = request!.headers.get("webhook-timestamp")!;
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(30);
    expect(verifyWebhook({ id: delivery!.event, timestamp, body: request!.body, signature: request!.headers.get("webhook-signature")!, secrets: [subscription.secret] })).toBe(true);
    expect(JSON.parse(request!.body)).toMatchObject({ id: delivery!.event, type: "order.created" });
    const entry = logs.find((log) => log.message === "webhook.delivery.succeeded")!;
    expect(entry).toMatchObject({ subscription: subscription.id, delivery: delivery!.id, type: "order.created", attempt: 1, status: 200 });
    expect(JSON.stringify(entry)).not.toContain(request!.body);
  });

  test("during a rotation the signature holds both secrets' signatures; after the expiry only the new one", async () => {
    const target = receiver();
    const { service } = await start();
    const created = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    const rotated = await webhooks.subscriptions.rotateSecret(created.id);
    await createOrder(service);
    await finished(service);
    const request = target.received[0]!;
    const signatures = request.headers.get("webhook-signature")!.split(" ");
    expect(signatures).toHaveLength(2);
    const message = { id: request.headers.get("webhook-id")!, timestamp: request.headers.get("webhook-timestamp")!, body: request.body };
    expect(verifyWebhook({ ...message, signature: signatures[0]!, secrets: [rotated.secret] })).toBe(true);
    expect(verifyWebhook({ ...message, signature: signatures[1]!, secrets: [created.secret] })).toBe(true);
    await (service.repos as unknown as { webhookSubscriptions: { update(id: string, changes: object): Promise<unknown> } }).webhookSubscriptions.update(created.id, { previousSecretExpiresAt: new Date(Date.now() - 1000) });
    await createOrder(service, "second");
    await finished(service, 2);
    expect(target.received[1]!.headers.get("webhook-signature")!.split(" ")).toHaveLength(1);
  });

  test("a redirect, an SSRF block, a large answer and a timeout are recorded on the delivery", async () => {
    const redirect = receiver(() => new Response(null, { status: 302, headers: { location: "https://example.com/" } }));
    const large = receiver(() => new Response("x".repeat(5 * 1024), { status: 500 }));
    const slow = receiver(async () => (await Bun.sleep(1500), new Response("late")));
    const { service } = await start('webhooks: { delivery: { timeout: "1s" } }');
    // A host that resolves to a public address when the subscription is created and to the loopback when it is called.
    let calls = 0;
    cleanups.push(useTestResolver({ "receiver.test": "127.0.0.1", "rebind.test": () => (++calls === 1 ? "93.184.216.34" : "127.0.0.1") }));
    for (const url of [redirect.url, large.url, slow.url, "http://rebind.test/hook"]) await webhooks.subscriptions.create({ url, events: ["order.created"] });
    await createOrder(service);
    const all = await finished(service, 4);
    const bySubscription = new Map((await webhooks.subscriptions.list()).data.map((subscription) => [subscription.id, subscription.url]));
    const of = async (url: string) => {
      const rows = (await (service.repos as unknown as { webhookDeliveries: { query(): { toArray(): Promise<(Delivery & { subscription: string })[]> } } }).webhookDeliveries.query().toArray()).filter((row) => bySubscription.get(row.subscription) === url);
      return rows[0]!;
    };
    expect(all).toHaveLength(4);
    expect(await of(redirect.url)).toMatchObject({ status: "failed", lastStatus: 302, lastError: "Redirects are not followed" });
    const failedLarge = await of(large.url);
    expect(failedLarge).toMatchObject({ status: "failed", lastStatus: 500, lastError: "500 Internal Server Error" });
    expect(failedLarge.lastResponse).toHaveLength(1024);
    const timedOut = await of(slow.url);
    expect(timedOut).toMatchObject({ status: "failed", lastStatus: 0 });
    expect(timedOut.lastError).toContain("timed out after 1s");
    const blocked = await of("http://rebind.test/hook");
    expect(blocked).toMatchObject({ status: "failed", lastStatus: 0 });
    expect(blocked.lastError).toContain("127.0.0.1 is a loopback address");
  });

  test("a 410 disables the subscription; its later deliveries fail with Subscription disabled without a request", async () => {
    const target = receiver(() => new Response("gone", { status: 410 }));
    // The consumers do not run, so the test runs each attempt itself.
    const { service } = await start("webhooks: {}", false, "consume: false");
    const { runningDeliveries } = await import("@quickservicets/core/features/webhooks/running.ts");
    const created = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await createOrder(service, "first");
    await createOrder(service, "second");
    const [first, second] = (await deliveries(service)).sort((a, b) => a.id.localeCompare(b.id));
    await runningDeliveries().deliver(first!.id, { signal: new AbortController().signal });
    expect(await webhooks.subscriptions.get(created.id)).toMatchObject({ enabled: false, disabledReason: "Receiver answered 410 Gone" });
    await runningDeliveries().deliver(second!.id, { signal: new AbortController().signal });
    const rows = new Map((await deliveries(service)).map((row) => [row.id, row]));
    expect(rows.get(first!.id)).toMatchObject({ status: "failed", lastStatus: 410 });
    expect(rows.get(second!.id)).toMatchObject({ status: "failed", lastError: "Subscription disabled", attempt: 0 });
    expect(target.received).toHaveLength(1);
  });

  test("with concurrency 2 a slow receiver never sees more than two requests at once; each attempt logs one entry", async () => {
    let active = 0;
    let most = 0;
    const target = receiver(async () => {
      active++;
      most = Math.max(most, active);
      await Bun.sleep(150);
      active--;
      return new Response("ok");
    });
    const { service, logs } = await start("webhooks: { delivery: { concurrency: 2 } }");
    await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await Promise.all(Array.from({ length: 6 }, (_, index) => createOrder(service, `o${index}`)));
    await finished(service, 6);
    expect(target.received).toHaveLength(6);
    expect(most).toBeLessThanOrEqual(2);
    expect(logs.filter((log) => log.message === "webhook.delivery.succeeded")).toHaveLength(6);
  });
});

describe("pings", () => {
  test("POST /webhooks/<id>/ping sends a signed webhook.ping without a delivery; the eleventh in a minute answers 429", async () => {
    const target = receiver(() => new Response(null, { status: 204 }));
    const { service } = await start("auth: {}, webhooks: {}", true);
    const created = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    const ping = () => service.fetch(`/webhooks/${created.id}/ping`, { method: "POST", headers: { "x-test-user": "ana;roles=admin" } });
    const first = await ping();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 204, ok: true });
    const request = target.received[0]!;
    const body = JSON.parse(request.body) as { type: string; data: unknown; id: string };
    expect(body).toMatchObject({ type: "webhook.ping", data: { subscriptionId: created.id } });
    expect(request.headers.get("webhook-id")).toBe(body.id);
    expect(verifyWebhook({ id: body.id, timestamp: request.headers.get("webhook-timestamp")!, body: request.body, signature: request.headers.get("webhook-signature")!, secrets: [created.secret] })).toBe(true);
    expect(await deliveries(service)).toHaveLength(0);
    for (let index = 0; index < 9; index++) expect((await ping()).status).toBe(200);
    const limited = await ping();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { message: string } }).error.message).toBe("Too many requests");
    await expect(webhooks.subscriptions.ping(created.id)).rejects.toThrow("Too many requests");
  });
});
