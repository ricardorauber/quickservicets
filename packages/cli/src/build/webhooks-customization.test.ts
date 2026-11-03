import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAdapter, registerProjectFeatures, resolveConfig, verifyWebhook, webhooks, type ServiceConfig } from "@quickservicets/core";
import { testAuth, useTestResolver } from "@quickservicets/core/testing";
import { runningDeliveries } from "@quickservicets/core/features/webhooks/running.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

const config = (keys: string, extra = "") => `import { defineConfig, memoryAdapter, HttpError } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  queues: { consume: false },
  http: { allow: ["receiver.test"] },
  logger: { info: (entry) => globalThis.customLogs?.push(entry), warn: (entry) => globalThis.customLogs?.push(entry), error() {} },
  ${extra}
  ${keys}
});
`;
const ORDER = "/** @webhooks */\nexport type Order = { status: string; total: number; notes?: string };\n";
const state = globalThis as unknown as { customLogs: { message: string }[]; calls: unknown[]; handled: unknown[] };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function receiver(answer: () => Response | Promise<Response> = () => new Response("ok")) {
  const received: { headers: Headers; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({ headers: request.headers, body: await request.text() });
      return answer();
    },
  });
  cleanups.push(() => server.stop(true));
  return { received, url: `http://receiver.test:${server.port}/hook` };
}

async function start(files: Record<string, string>, env: Record<string, string> = {}, auth = false) {
  state.customLogs = [];
  state.calls = [];
  state.handled = [];
  cleanups.push(useTestResolver({ "receiver.test": "127.0.0.1" }));
  const service = await startTestService({ files, env, ...(auth ? { auth: testAuth() } : {}) });
  cleanups.push(() => service.stop());
  return service;
}
const deliver = (id: string) => runningDeliveries().deliver(id, { signal: new AbortController().signal });
type Delivery = { id: string; type: string; status: string; attempt: number; lastStatus?: number; lastError?: string; payload: { data: { record: Record<string, unknown> } } };
const deliveries = async (service: TestService) => (service.repos as unknown as { webhookDeliveries: { query(): { toArray(): Promise<Delivery[]> } } }).webhookDeliveries.query().toArray();
const post = (service: TestService, path: string, body: unknown, headers: Record<string, string> = {}) => service.fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("environment variables", () => {
  test("every option has its variable", () => {
    const resolved = resolveConfig({ database: memoryAdapter(), webhooks: {} } as ServiceConfig, {
      QS_WEBHOOKS_EVENTS: "invoice.*,payment.*",
      QS_WEBHOOKS_ROUTES_ENABLED: "false",
      QS_WEBHOOKS_ROUTES_PATH: "/hooks",
      QS_WEBHOOKS_ROUTES_ROLES: "ops,admin",
      QS_WEBHOOKS_DELIVERY_TIMEOUT: "2s",
      QS_WEBHOOKS_DELIVERY_RETRY_SCHEDULE: "1s,1m",
      QS_WEBHOOKS_DELIVERY_DISABLE_AFTER: "1d",
      QS_WEBHOOKS_DELIVERY_REQUIRE_HTTPS: "true",
      QS_WEBHOOKS_DELIVERY_RETENTION: "7d",
      QS_WEBHOOKS_INCOMING_TOLERANCE: "10m",
      QS_WEBHOOKS_INCOMING_DEDUPE_ENABLED: "false",
    });
    expect(resolved.features.find((feature) => feature.key === "webhooks")!.options).toMatchObject({
      events: ["invoice.*", "payment.*"],
      routes: { enabled: false, path: "/hooks", roles: ["ops", "admin"] },
      delivery: { timeout: "2s", retrySchedule: ["1s", "1m"], disableAfter: "1d", requireHttps: true, retention: "7d" },
      incoming: { tolerance: "10m", dedupe: { enabled: false } },
    });
    expect(resolveConfig({ database: memoryAdapter() } as ServiceConfig, { QS_WEBHOOKS_ENABLED: "true" }).features.some((feature) => feature.key === "webhooks")).toBe(true);
  });

  test("QS_WEBHOOKS_DELIVERY_TIMEOUT=2s fails a 3-second receiver; QS_WEBHOOKS_EVENTS makes custom events deliverable", async () => {
    const target = receiver(async () => (await Bun.sleep(3000), new Response("late")));
    const service = await start({ "quickservicets.config.ts": config("webhooks: {}"), "entities/Order.ts": ORDER }, { QS_WEBHOOKS_DELIVERY_TIMEOUT: "2s", QS_WEBHOOKS_EVENTS: "invoice.*" });
    await webhooks.subscriptions.create({ url: target.url, events: ["order.created", "invoice.paid"] });
    await post(service, "/orders", { status: "new", total: 1 });
    const [delivery] = await deliveries(service);
    await deliver(delivery!.id);
    expect((await deliveries(service))[0]!.lastError).toContain("timed out after 2s");
  }, 15_000);
});

describe("tags", () => {
  test("@webhooks fields= limits the record; @webhooks off wins over a matching pattern; an unknown field fails the build", async () => {
    const service = await start({
      "quickservicets.config.ts": config('webhooks: { events: ["*.created"] }'),
      "entities/Order.ts": "/** @webhooks fields=status,total */\nexport type Order = { status: string; total: number; notes?: string };\n",
      "entities/Draft.ts": "/** @webhooks off */\nexport type Draft = { text: string };\n",
    });
    await webhooks.subscriptions.create({ url: "https://hooks.example/a", events: ["*.created"] });
    await post(service, "/orders", { status: "new", total: 3, notes: "secret plan" });
    await post(service, "/drafts", { text: "x" });
    const all = await deliveries(service);
    expect(all.map((delivery) => delivery.type)).toEqual(["order.created"]);
    expect(Object.keys(all[0]!.payload.data.record).sort()).toEqual(["id", "status", "total"]);
    const broken = createLinkedProject({ "quickservicets.config.ts": config("webhooks: {}"), "entities/Order.ts": "/** @webhooks fields=nope */\nexport type Order = { status: string };\n" });
    await expect(build(broken)).rejects.toThrow("entities/Order.ts: invalid @webhooks: unknown field nope");
  });

  test("@webhook dedupe=false lets one route run a repeated delivery twice while another still deduplicates; @webhook on post.ts fails", async () => {
    const webhook = (route: string, tag = "") => `import { defineWebhook, githubSignature } from "@quickservicets/core";
${tag}
export default defineWebhook({ verify: githubSignature({ secret: "s" }), handle: () => void (globalThis as unknown as { handled: string[] }).handled.push("${route}") });
`;
    const service = await start({ "quickservicets.config.ts": config("webhooks: {}"), "endpoints/plain/webhook.ts": webhook("plain", "/** @webhook dedupe=false tolerance=10m */"), "endpoints/kept/webhook.ts": webhook("kept") });
    const body = JSON.stringify({ a: 1 });
    const headers = { "x-hub-signature-256": `sha256=${createHmac("sha256", "s").update(body).digest("hex")}`, "x-github-delivery": "d-1" };
    for (let index = 0; index < 2; index++) {
      for (const route of ["/plain", "/kept"]) await service.fetch(route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    }
    expect(state.handled).toEqual(["plain", "kept", "plain"]);
    const misplaced = createLinkedProject({ "quickservicets.config.ts": config("webhooks: {}"), "endpoints/hello/post.ts": "/** @webhook dedupe=false */\nexport default () => ({});\n" });
    await expect(build(misplaced)).rejects.toThrow("endpoints/hello/post.ts: invalid @webhook: only webhook.ts files take @webhook");
  });
});

describe("per request and hooks", () => {
  test("a delivery.headers function and a beforeDeliver hook change what is sent and signed; a throwing hook ends the delivery without retry", async () => {
    const target = receiver();
    const service = await start({
      "quickservicets.config.ts": config(`webhooks: {
    delivery: { headers: ({ tenant }) => ({ "x-tenant": tenant ?? "none" }) },
    beforeDeliver: ({ body, headers, delivery }) => {
      if ((body as { data: { record: { status: string } } }).data.record.status === "refuse") throw new Error("not this one");
      return { body: { ...(body as object), extra: delivery.type }, headers };
    },
  },`),
      "entities/Order.ts": ORDER,
    });
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await post(service, "/orders", { status: "new", total: 1 });
    const [first] = await deliveries(service);
    await deliver(first!.id);
    const request = target.received[0]!;
    expect(request.headers.get("x-tenant")).toBe("none");
    expect(JSON.parse(request.body)).toMatchObject({ type: "order.created", extra: "order.created" });
    expect(verifyWebhook({ id: request.headers.get("webhook-id")!, timestamp: request.headers.get("webhook-timestamp")!, body: request.body, signature: request.headers.get("webhook-signature")!, secrets: [subscription.secret] })).toBe(true);
    await post(service, "/orders", { status: "refuse", total: 1 });
    const refused = (await deliveries(service)).find((delivery) => delivery.id !== first!.id)!;
    await deliver(refused.id);
    expect((await deliveries(service)).find((delivery) => delivery.id === refused.id)).toMatchObject({ status: "failed", attempt: 1, lastError: "Canceled by beforeDeliver: not this one" });
    expect(target.received).toHaveLength(1);
  });

  test("onDisabled sees a 410; beforeHandle throwing HttpError(422) answers 422 and fails the receipt; a registered verifier verifies a file", async () => {
    const target = receiver(() => new Response("gone", { status: 410 }));
    const service = await start({
      "quickservicets.config.ts": config(`webhooks: {
    onDisabled: ({ subscription, reason }) => void (globalThis as unknown as { calls: unknown[] }).calls.push({ id: subscription.id, reason }),
    beforeHandle: ({ event }) => {
      if ((event as { reject?: boolean }).reject) throw new HttpError(422, "Rejected");
    },
  },
  acme: {},`),
      "features/acme/index.ts": `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "acme",
  after: ["webhooks"],
  setup(ctx) {
    ctx.feature("webhooks").verifier("acme", { name: "acme", verify: ({ headers }) => (headers.get("x-acme") === "yes" ? { ok: true, deliveryId: headers.get("x-id") ?? undefined } : { ok: false, reason: "mismatch" }) });
  },
});
`,
      "endpoints/acme/webhook.ts": `import { defineWebhook } from "@quickservicets/core";
export default defineWebhook({ verify: "acme", handle: () => void (globalThis as unknown as { handled: string[] }).handled.push("acme") });
`,
      "entities/Order.ts": ORDER,
    });
    const subscription = await webhooks.subscriptions.create({ url: target.url, events: ["order.created"] });
    await post(service, "/orders", { status: "new", total: 1 });
    await deliver((await deliveries(service))[0]!.id);
    expect(state.calls).toEqual([{ id: subscription.id, reason: "Receiver answered 410 Gone" }]);
    expect((await post(service, "/acme", { ok: true }, { "x-acme": "yes", "x-id": "1" })).status).toBe(200);
    expect((await post(service, "/acme", { ok: true }, { "x-acme": "no" })).status).toBe(401);
    expect(state.handled).toEqual(["acme"]);
    expect((await post(service, "/acme", { reject: true }, { "x-acme": "yes", "x-id": "2" })).status).toBe(422);
    const receipts = await (service.repos as unknown as { webhookReceipts: { query(): { toArray(): Promise<{ deliveryId: string; status: string }[]> } } }).webhookReceipts.query().toArray();
    expect(receipts.find((receipt) => receipt.deliveryId === "2")).toMatchObject({ status: "failed" });
  });

  test("a file naming an unregistered verifier fails startup naming it", async () => {
    await expect(
      startTestService({ files: { "quickservicets.config.ts": config("webhooks: {}"), "endpoints/acme/webhook.ts": 'import { defineWebhook } from "@quickservicets/core";\nexport default defineWebhook({ verify: "acme", handle: () => {} });\n' } }),
    ).rejects.toThrow("Unknown webhook verifier acme in endpoints/acme/webhook.ts (registered: none)");
  });
});

describe("overrides and the sender", () => {
  test("a project endpoints/webhooks/get.ts replaces the list route; a project WebhookSubscription may add fields but not drop the native's", async () => {
    const service = await start({ "quickservicets.config.ts": config("auth: {}, webhooks: {}"), "entities/Order.ts": ORDER, "endpoints/webhooks/get.ts": "export default () => ({ mine: true });\n" }, {}, true);
    expect(await (await service.fetch("/webhooks", { headers: { "x-test-user": "a;roles=admin" } })).json()).toEqual({ mine: true });
    const subscription = (fields: string) => `export type WebhookSubscription = {
${fields}
};
`;
    const own = `  url: string;
  events: string[];
  description?: string;
  /** @hidden */
  secret: string;
  /** @hidden */
  previousSecret?: string;
  previousSecretExpiresAt?: Date;
  /** @default true */
  enabled: boolean;
  disabledReason?: string;
  failingSince?: Date;
  tenant?: string;
  createdBy?: string;`;
    const extended = createLinkedProject({ "quickservicets.config.ts": config("webhooks: {}"), "entities/WebhookSubscription.ts": subscription(`${own}\n  label?: string;`) });
    await build(extended);
    const dropped = createLinkedProject({ "quickservicets.config.ts": config("webhooks: {}"), "entities/WebhookSubscription.ts": subscription(own.replace("  /** @hidden */\n  secret: string;\n", "")) });
    await expect(build(dropped)).rejects.toThrow("entities/WebhookSubscription.ts: WebhookSubscription needs the field secret (string) used by webhooks");
  });

  test("a sender receives each delivery, its status reaches the delivery log, and retries still follow the schedule", async () => {
    const service = await start({
      "quickservicets.config.ts": config(`webhooks: {
    delivery: { retrySchedule: ["1s"] },
    sender: {
      async send({ subscription, delivery, body, headers }) {
        const calls = (globalThis as unknown as { calls: unknown[] }).calls;
        calls.push({ subscription: subscription.id, delivery: delivery.id, attempt: delivery.attempt, type: JSON.parse(body).type, signed: "webhook-signature" in headers });
        return { status: calls.length === 1 ? 503 : 202, body: "queued", durationMs: 1 };
      },
    },
  },`),
      "entities/Order.ts": ORDER,
    });
    await webhooks.subscriptions.create({ url: "https://hooks.example/a", events: ["order.created"] });
    await post(service, "/orders", { status: "new", total: 1 });
    const [delivery] = await deliveries(service);
    await deliver(delivery!.id);
    expect((await deliveries(service))[0]).toMatchObject({ status: "pending", attempt: 1, lastStatus: 503 });
    await deliver(delivery!.id);
    expect((await deliveries(service))[0]).toMatchObject({ status: "succeeded", attempt: 2, lastStatus: 202 });
    expect(state.calls).toMatchObject([
      { delivery: delivery!.id, attempt: 1, type: "order.created", signed: false },
      { delivery: delivery!.id, attempt: 2 },
    ]);
  });

  test("the reference page lists the hooks, the tags and the sender contract", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/webhooks.mdx"), "utf8");
    for (const text of ["beforeDeliver", "afterDeliver", "onDisabled", "beforeHandle", "afterHandle", "### `@webhooks`", "### `@webhook`", "WebhookSender", "verifier", "webhooks resend"]) expect(page).toContain(text);
  });
});
