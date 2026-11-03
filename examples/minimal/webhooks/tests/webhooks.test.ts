import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { verifyWebhook, webhookClock } from "@quickservicets/core";
import { runningDeliveries } from "@quickservicets/core/features/webhooks/running.ts";
import { startTestService, type TestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A receiver on the loopback, which the test config lets the HTTP client reach, answering the next of `statuses`. */
function receiver(statuses: number[]) {
  const received: { headers: Headers; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({ headers: request.headers, body: await request.text() });
      return new Response("ok", { status: statuses[Math.min(received.length - 1, statuses.length - 1)] });
    },
  });
  cleanups.push(() => server.stop(true));
  return { received, url: `http://127.0.0.1:${server.port}/hook` };
}

async function start(): Promise<TestService> {
  // Consumers stay off, so the test runs each attempt itself and moves the native's clock between them.
  const files = exampleFiles();
  files["quickservicets.config.ts"] = files["quickservicets.config.ts"]!.replace("  webhooks: {", "  queues: { consume: false },\n  webhooks: {");
  const service = await startTestService({ files, env: { QS_HTTP_ALLOW: "127.0.0.1" } });
  cleanups.push(() => service.stop());
  return service;
}

const ADMIN = { "content-type": "application/json", "x-test-user": "ana;roles=admin" };
const deliver = (id: string) => runningDeliveries().deliver(id, { signal: new AbortController().signal });
type Delivery = { id: string; event: string; type: string; status: string; attempt: number; nextAttemptAt?: string };

test("a subscription gets signed deliveries, retried until success, disabled after a 410, and resent from the log", async () => {
  const target = receiver([500, 503, 200, 200, 410, 200]);
  const service = await start();
  const clock = { now: Date.now() };
  const original = webhookClock.now;
  webhookClock.now = () => clock.now;
  cleanups.push(() => (webhookClock.now = original));
  const created = await service.fetch("/webhooks", { method: "POST", headers: ADMIN, body: JSON.stringify({ url: target.url, events: ["order.created", "invoice.paid"] }) });
  expect(created.status).toBe(201);
  const subscription = (await created.json()) as { id: string; secret: string };
  const log = async () => ((await (await service.fetch(`/webhooks/${subscription.id}/deliveries`, { headers: ADMIN })).json()) as { data: Delivery[] }).data;

  await service.fetch("/orders", { method: "POST", headers: ADMIN, body: JSON.stringify({ status: "new", total: 10 }) });
  const [order] = await log();
  // Two failures, then success: each retry runs once the clock reaches its nextAttemptAt.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await deliver(order!.id);
    const [current] = await log();
    if (attempt < 3) clock.now = Date.parse(current!.nextAttemptAt!);
    else expect(current).toMatchObject({ status: "succeeded", attempt: 3 });
  }
  const request = target.received[2]!;
  expect(request.headers.get("webhook-id")).toBe(order!.event);
  expect(verifyWebhook({ id: request.headers.get("webhook-id")!, timestamp: request.headers.get("webhook-timestamp")!, body: request.body, signature: request.headers.get("webhook-signature")!, secrets: [subscription.secret] })).toBe(true);
  expect(JSON.parse(request.body)).toMatchObject({ type: "order.created", data: { entity: "Order", record: { status: "new", total: 10 } } });

  // The custom event is delivered too; a 410 on the next one disables the subscription.
  await service.fetch("/invoices/in_1/pay", { method: "POST", headers: ADMIN });
  const invoice = (await log()).find((delivery) => delivery.type === "invoice.paid")!;
  await deliver(invoice.id);
  expect(JSON.parse(target.received[3]!.body)).toMatchObject({ type: "invoice.paid", data: { invoiceId: "in_1" } });
  await service.fetch("/orders", { method: "POST", headers: ADMIN, body: JSON.stringify({ status: "second", total: 1 }) });
  const second = (await log()).find((delivery) => delivery.status === "pending")!;
  await deliver(second.id);
  const disabled = (await (await service.fetch(`/webhooks/${subscription.id}`, { headers: ADMIN })).json()) as { enabled: boolean; disabledReason: string };
  expect(disabled).toMatchObject({ enabled: false, disabledReason: "Receiver answered 410 Gone" });

  // Re-enabled, the failed delivery is resent from the log with the same webhook-id.
  await service.fetch(`/webhooks/${subscription.id}`, { method: "PATCH", headers: ADMIN, body: JSON.stringify({ enabled: true }) });
  const resent = await service.fetch(`/webhooks/${subscription.id}/deliveries/${second.id}/resend`, { method: "POST", headers: ADMIN });
  expect(resent.status).toBe(202);
  await deliver(second.id);
  expect((await log()).find((delivery) => delivery.id === second.id)).toMatchObject({ status: "succeeded", attempt: 1 });
  expect(target.received.at(-1)!.headers.get("webhook-id")).toBe(second.event);
});

test("a GitHub push is recorded once, a repeat answers as a duplicate, and a wrong signature answers 401", async () => {
  const service = await start();
  const body = JSON.stringify({ ref: "refs/heads/main" });
  const signature = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const push = (secret = "github-example-secret") =>
    service.fetch("/github", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "d-1", "x-hub-signature-256": signature(secret) }, body });
  expect(await (await push()).json()).toEqual({ received: true });
  expect(await (await push()).json()).toEqual({ received: true, duplicate: true });
  const pushes = await (service.repos as unknown as { pushes: { query(): { toArray(): Promise<{ delivery: string; ref: string }[]> } } }).pushes.query().toArray();
  expect(pushes).toMatchObject([{ delivery: "d-1", ref: "refs/heads/main" }]);
  const wrong = await push("not-the-secret");
  expect(wrong.status).toBe(401);
  expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("INVALID_SIGNATURE");
});
