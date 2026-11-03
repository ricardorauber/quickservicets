import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { registerProjectFeatures, webhookClock, type EntityModel } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

const SECRET = "stripe-secret";
const config = (keys = "webhooks: {}") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), queues: { pollInterval: "20ms" }, logger: { info: (entry) => globalThis.dedupeLogs?.push(entry), warn: (entry) => globalThis.dedupeLogs?.push(entry), error() {} }, ${keys} });
`;
const state = globalThis as unknown as { runs: { route: string; id: string; deliveryId?: string; req: boolean }[]; dedupeLogs: { message: string }[]; gate?: Promise<void>; failures?: number };
const handler = (route: string) => `async (event, ctx) => {
    const state = globalThis as unknown as { runs: unknown[]; gate?: Promise<void>; failures?: number };
    if ((event as { fail?: boolean }).fail && (state.failures ?? 0) > 0) {
      state.failures = (state.failures ?? 0) - 1;
      throw new Error("try again");
    }
    if ((event as { wait?: boolean }).wait) await state.gate;
    state.runs.push({ route: "${route}", id: (event as { id: string }).id, deliveryId: ctx.deliveryId, req: ctx.req !== undefined });
  }`;
const FILES = {
  "endpoints/stripe/webhook.ts": `import { defineWebhook, stripeSignature } from "@quickservicets/core";
export default defineWebhook({ verify: stripeSignature({ secret: "${SECRET}" }), handle: ${handler("stripe")} });
`,
  "endpoints/background/webhook.ts": `import { defineWebhook, stripeSignature } from "@quickservicets/core";
export default defineWebhook({ async: true, verify: stripeSignature({ secret: "${SECRET}" }), handle: ${handler("background")} });
`,
  "endpoints/anonymous/webhook.ts": `import { defineWebhook, hmacSignature } from "@quickservicets/core";
export default defineWebhook({ verify: hmacSignature({ header: "x-signature", secret: "${SECRET}", algorithm: "sha256", encoding: "hex" }), handle: ${handler("anonymous")} });
`,
};

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(keys?: string, env: Record<string, string> = {}) {
  state.runs = [];
  state.dedupeLogs = [];
  state.failures = 0;
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), ...FILES }, env });
  cleanups.push(() => service.stop());
  return service;
}

const signed = (payload: string) => {
  const timestamp = Math.floor(webhookClock.now() / 1000);
  return { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${createHmac("sha256", SECRET).update(`${timestamp}.${payload}`).digest("hex")}` };
};
const send = (service: TestService, path: string, event: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(event);
  return service.fetch(path, { method: "POST", headers: { ...signed(body), ...headers }, body });
};
type Receipt = { endpoint: string; deliveryId: string; status: string; tenant?: string | null };
const receipts = async (service: TestService) => (service.repos as unknown as { webhookReceipts: { query(): { toArray(): Promise<Receipt[]> } } }).webhookReceipts.query().toArray();
const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
};

describe("dedupe", () => {
  test("the same event twice runs handle once; the second answer says duplicate", async () => {
    const service = await start();
    const first = await send(service, "/stripe", { id: "evt_1" });
    expect(await first.json()).toEqual({ received: true });
    const second = await send(service, "/stripe", { id: "evt_1" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(state.runs).toEqual([{ route: "stripe", id: "evt_1", deliveryId: "evt_1", req: true }]);
    expect(await receipts(service)).toMatchObject([{ endpoint: "/stripe", deliveryId: "evt_1", status: "processed" }]);
    expect(state.dedupeLogs.some((entry) => entry.message === "webhook.incoming.duplicate")).toBe(true);
  });

  test("two simultaneous deliveries run handle once and the other answers 409 with Retry-After: 5", async () => {
    const service = await start();
    let open!: () => void;
    state.gate = new Promise<void>((resolve) => (open = resolve));
    const first = send(service, "/stripe", { id: "evt_2", wait: true });
    await until(async () => (await receipts(service)).length === 1);
    const second = await send(service, "/stripe", { id: "evt_2", wait: true });
    expect(second.status).toBe(409);
    expect(second.headers.get("retry-after")).toBe("5");
    expect(((await second.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "CONFLICT", message: "Webhook delivery is being processed" });
    open();
    expect((await first).status).toBe(200);
    expect(state.runs).toHaveLength(1);
  });

  test("a receipt left processing by a stopped process is taken over once its 60-second lock passed (fake clock)", async () => {
    const service = await start();
    const clock = { now: Date.now() };
    const original = webhookClock.now;
    webhookClock.now = () => clock.now;
    cleanups.push(() => (webhookClock.now = original));
    state.gate = new Promise<void>(() => {});
    void send(service, "/stripe", { id: "evt_3", wait: true });
    await until(async () => (await receipts(service)).length === 1);
    expect((await send(service, "/stripe", { id: "evt_3" })).status).toBe(409);
    clock.now += 61_000;
    state.gate = undefined;
    const taken = await send(service, "/stripe", { id: "evt_3" });
    expect(taken.status).toBe(200);
    expect(state.runs.map((run) => run.id)).toEqual(["evt_3"]);
  });

  test("a handle that throws leaves a failed receipt, and the sender's retry runs handle again", async () => {
    const service = await start();
    state.failures = 1;
    expect((await send(service, "/stripe", { id: "evt_4", fail: true })).status).toBe(500);
    expect(await receipts(service)).toMatchObject([{ deliveryId: "evt_4", status: "failed" }]);
    expect((await send(service, "/stripe", { id: "evt_4", fail: true })).status).toBe(200);
    expect(await receipts(service)).toMatchObject([{ deliveryId: "evt_4", status: "processed" }]);
    expect(state.runs).toHaveLength(1);
  });

  test("with tenancy the same delivery id is processed once per tenant", async () => {
    const service = await start('webhooks: {}, tenancy: { source: "config", tenants: { acme: {}, globex: {} } }');
    for (const tenant of ["acme", "globex", "acme"]) await send(service, "/stripe", { id: "evt_5" }, { "x-tenant-id": tenant });
    expect(state.runs).toHaveLength(2);
    expect((await receipts(service)).map((receipt) => receipt.tenant).sort()).toEqual(["acme", "globex"]);
  });

  test("a verifier without a delivery id skips dedupe and says so once per route", async () => {
    const service = await start();
    const body = JSON.stringify({ id: "x" });
    const headers = { "content-type": "application/json", "x-signature": createHmac("sha256", SECRET).update(body).digest("hex") };
    for (let index = 0; index < 2; index++) expect((await service.fetch("/anonymous", { method: "POST", headers, body })).status).toBe(200);
    expect(state.runs).toHaveLength(2);
    expect(state.dedupeLogs.filter((entry) => entry.message === "webhook.incoming.no-delivery-id")).toHaveLength(1);
  });

  test("with dedupe disabled a repeated delivery runs handle twice and the build adds no receipt entity", async () => {
    const service = await start("webhooks: {}", { QS_WEBHOOKS_INCOMING_DEDUPE_ENABLED: "false" });
    await send(service, "/stripe", { id: "evt_6" });
    await send(service, "/stripe", { id: "evt_6" });
    expect(state.runs).toHaveLength(2);
    const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
    expect(models.some((model) => model.key === "WebhookReceipt")).toBe(false);
  });
});

describe("asynchronous handling", () => {
  test("async: true answers 202 at once, the consumer runs handle without a request, and a failure is retried by the queue", async () => {
    const service = await start('webhooks: {}, queues: { pollInterval: "20ms", retryDelay: "10ms" }');
    state.failures = 1;
    const answer = await send(service, "/background", { id: "evt_7", fail: true });
    expect(answer.status).toBe(202);
    expect(await answer.json()).toEqual({ received: true });
    await until(() => state.runs.length === 1);
    expect(state.runs).toEqual([{ route: "background", id: "evt_7", deliveryId: "evt_7", req: false }]);
    await until(async () => (await receipts(service))[0]?.status === "processed");
    expect(await (await send(service, "/background", { id: "evt_7" })).json()).toEqual({ received: true, duplicate: true });
  });

  test("webhooks turns queues on, so turning queues off fails the configuration before any async route is built", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config("webhooks: {}, queues: false"), "endpoints/background/webhook.ts": FILES["endpoints/background/webhook.ts"] });
    await expect(build(root)).rejects.toThrow("webhooks needs queues, but queues is false; remove queues: false or turn off webhooks");
  });
});
