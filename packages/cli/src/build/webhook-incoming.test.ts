import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { registerProjectFeatures, signWebhook, type AuthProvider } from "@quickservicets/core";
import { testAuth } from "@quickservicets/core/testing";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

const STRIPE_SECRET = "whsec_stripe_test_secret";
const GITHUB_SECRET = "github-secret";
const PARTNER_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

const config = (keys = "webhooks: {}") => `import { defineConfig, memoryAdapter, string } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  env: { STRIPE_WEBHOOK_SECRET: string().default("") },
  logger: { info: (entry) => globalThis.incomingLogs?.push(entry), warn: (entry) => globalThis.incomingLogs?.push(entry), error() {} },
  ${keys}
});
`;
const record = `(globalThis as unknown as { handled: unknown[] }).handled.push`;
const FILES: Record<string, string> = {
  "endpoints/stripe/webhook.ts": `import { defineWebhook, env, stripeSignature } from "@quickservicets/core";
export default defineWebhook<{ id: string; type: string }>({
  verify: stripeSignature({ secret: env.STRIPE_WEBHOOK_SECRET }),
  handle: (event, ctx) => void ${record}({ route: "stripe", event, deliveryId: ctx.deliveryId, eventType: ctx.eventType, raw: new TextDecoder().decode(ctx.rawBody) }),
});
`,
  "endpoints/github/webhook.ts": `import { defineWebhook, githubSignature } from "@quickservicets/core";
export default defineWebhook({
  verify: githubSignature({ secret: "${GITHUB_SECRET}" }),
  handle: (event, ctx) => void ${record}({ route: "github", event, deliveryId: ctx.deliveryId, eventType: ctx.eventType }),
});
`,
  "endpoints/partner/webhook.ts": `import { defineWebhook, standardWebhookSignature } from "@quickservicets/core";
export default defineWebhook({
  verify: standardWebhookSignature({ secret: "${PARTNER_SECRET}" }),
  handle: (event, ctx) => void ${record}({ route: "partner", event, deliveryId: ctx.deliveryId }),
});
`,
  "endpoints/plain/webhook.ts": `import { defineWebhook, hmacSignature } from "@quickservicets/core";
export default defineWebhook({
  verify: hmacSignature({ header: "x-signature", secret: ["old-secret", "new-secret"], algorithm: "sha1", encoding: "base64" }),
  handle: (event) => void ${record}({ route: "plain", event }),
});
`,
  "endpoints/tenants/webhook.ts": `import { defineWebhook, hmacSignature } from "@quickservicets/core";
export default defineWebhook({
  verify: hmacSignature({ header: "x-signature", secret: ({ tenant }) => \`secret-of-\${tenant}\`, algorithm: "sha256", encoding: "hex", prefix: "sha256=" }),
  handle: (event) => void ${record}({ route: "tenants", event }),
});
`,
  "endpoints/broken/webhook.ts": `import { defineWebhook, hmacSignature, HttpError } from "@quickservicets/core";
export default defineWebhook<{ fail: string }>({
  verify: hmacSignature({ header: "x-signature", secret: "s", algorithm: "sha256", encoding: "hex" }),
  handle: (event) => {
    if (event.fail === "http") throw new HttpError(422, "Not processable");
    throw new Error("db down");
  },
});
`,
};

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});
const state = globalThis as unknown as { handled: Record<string, unknown>[]; incomingLogs: { message: string; reason?: string; route?: string }[] };

/** Signs in by the `session` cookie, so the CSRF item checks the request. */
const cookieAuth: AuthProvider = { name: "session", credentials: { cookies: ["session"] }, authenticate: (req) => ({ user: { id: "u1" }, method: "cookie" }) };

async function start(keys?: string, files: Record<string, string> = FILES, auth = false) {
  state.handled = [];
  state.incomingLogs = [];
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), ...files }, env: { STRIPE_WEBHOOK_SECRET: STRIPE_SECRET }, ...(auth ? { auth: [testAuth(), cookieAuth] } : {}) });
  running.push(service);
  return service;
}

/** A Stripe-Signature header, as Stripe's test helper builds it. */
const stripeHeader = (payload: string, secret = STRIPE_SECRET, timestamp = Math.floor(Date.now() / 1000)) => `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
const post = (service: TestService, path: string, body: string, headers: Record<string, string>) => service.fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const STRIPE_EVENT = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_1" } } });

describe("verifiers", () => {
  test("a Stripe-signed request is accepted and the handler sees the event id as the delivery id", async () => {
    const service = await start();
    const response = await post(service, "/stripe", STRIPE_EVENT, { "stripe-signature": stripeHeader(STRIPE_EVENT) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(state.handled).toEqual([{ route: "stripe", event: JSON.parse(STRIPE_EVENT), deliveryId: "evt_1", eventType: "invoice.paid", raw: STRIPE_EVENT }]);
  });

  test("an old timestamp, a changed body and a missing header answer 401 and log their reason, never running handle", async () => {
    const service = await start();
    const stale = stripeHeader(STRIPE_EVENT, STRIPE_SECRET, Math.floor(Date.now() / 1000) - 600);
    const answers = [
      await post(service, "/stripe", STRIPE_EVENT, { "stripe-signature": stale }),
      await post(service, "/stripe", STRIPE_EVENT.replace("in_1", "in_2"), { "stripe-signature": stripeHeader(STRIPE_EVENT) }),
      await post(service, "/stripe", STRIPE_EVENT, {}),
      await post(service, "/stripe", STRIPE_EVENT, { "stripe-signature": "garbage" }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(((await answer.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "INVALID_SIGNATURE", message: "Invalid webhook signature" });
    }
    expect(state.incomingLogs.filter((entry) => entry.message === "webhook.incoming.rejected").map((entry) => [entry.route, entry.reason])).toEqual([
      ["POST /stripe", "expired"],
      ["POST /stripe", "mismatch"],
      ["POST /stripe", "missing"],
      ["POST /stripe", "malformed"],
    ]);
    expect(JSON.stringify(state.incomingLogs)).not.toContain("in_1");
    expect(state.handled).toEqual([]);
  });

  test("GitHub, Standard Webhooks and plain HMAC signatures, with a rotation list and a per-tenant secret", async () => {
    const service = await start('webhooks: {}, tenancy: { source: "config", tenants: { acme: {}, globex: {} } }');
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const github = await post(service, "/github", body, { "x-hub-signature-256": `sha256=${createHmac("sha256", GITHUB_SECRET).update(body).digest("hex")}`, "x-github-event": "push", "x-github-delivery": "d-1", "x-tenant-id": "acme" });
    expect(github.status).toBe(200);
    expect(state.handled.at(-1)).toMatchObject({ route: "github", eventType: "push", deliveryId: "d-1" });
    const timestamp = Math.floor(Date.now() / 1000);
    const partner = await post(service, "/partner", body, { "webhook-id": "msg_1", "webhook-timestamp": String(timestamp), "webhook-signature": signWebhook({ id: "msg_1", timestamp, body, secret: PARTNER_SECRET }), "x-tenant-id": "acme" });
    expect(partner.status).toBe(200);
    expect(state.handled.at(-1)).toMatchObject({ route: "partner", deliveryId: "msg_1" });
    for (const secret of ["old-secret", "new-secret"]) {
      const plain = await post(service, "/plain", body, { "x-signature": createHmac("sha1", secret).update(body).digest("base64"), "x-tenant-id": "acme" });
      expect(plain.status).toBe(200);
    }
    expect((await post(service, "/plain", body, { "x-signature": createHmac("sha1", "other").update(body).digest("base64"), "x-tenant-id": "acme" })).status).toBe(401);
    const signed = (tenant: string) => `sha256=${createHmac("sha256", `secret-of-${tenant}`).update(body).digest("hex")}`;
    expect((await post(service, "/tenants", body, { "x-signature": signed("acme"), "x-tenant-id": "acme" })).status).toBe(200);
    expect((await post(service, "/tenants", body, { "x-signature": signed("acme"), "x-tenant-id": "globex" })).status).toBe(401);
  });
});

describe("the route", () => {
  test("a handler HttpError answers itself and any other error 500; a body over maxBodySize answers 413", async () => {
    const service = await start('webhooks: { incoming: { maxBodySize: "1MB" } }');
    const sign = (body: string) => ({ "x-signature": createHmac("sha256", "s").update(body).digest("hex") });
    const http = JSON.stringify({ fail: "http" });
    expect((await post(service, "/broken", http, sign(http))).status).toBe(422);
    const other = JSON.stringify({ fail: "other" });
    expect((await post(service, "/broken", other, sign(other))).status).toBe(500);
    const large = JSON.stringify({ fail: "x".repeat(2 * 1024 * 1024) });
    expect((await post(service, "/broken", large, sign(large))).status).toBe(413);
  });

  test("a cookie-authenticated cross-site request is not refused by CSRF, and /openapi.json documents x-webhook", async () => {
    const service = await start("auth: {}, webhooks: {}", { ...FILES, "endpoints/echo/post.ts": "export default () => ({ ok: true });\n" }, true);
    const crossSite = { cookie: "session=abc", origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    // The same request to an ordinary route is refused by the CSRF item.
    expect((await post(service, "/echo", "{}", crossSite)).status).toBe(403);
    const response = await post(service, "/stripe", STRIPE_EVENT, { "stripe-signature": stripeHeader(STRIPE_EVENT), ...crossSite });
    expect(response.status).toBe(200);
    const doc = (await (await service.fetch("/openapi.json")).json()) as { paths: Record<string, Record<string, { "x-webhook"?: unknown; responses: Record<string, unknown> }>> };
    expect(doc.paths["/stripe"]!.post!["x-webhook"]).toEqual({ verifier: "stripe" });
    expect(doc.paths["/github"]!.post!["x-webhook"]).toEqual({ verifier: "github" });
    expect(doc.paths["/partner"]!.post!["x-webhook"]).toEqual({ verifier: "standard-webhooks" });
    expect(doc.paths["/plain"]!.post!["x-webhook"]).toEqual({ verifier: "hmac" });
    expect(doc.paths["/stripe"]!.post!.responses).toHaveProperty("200");
  });
});

describe("build rules", () => {
  test("webhook.ts next to post.ts, without the native, or without defineWebhook fails the build", async () => {
    const webhook = FILES["endpoints/github/webhook.ts"]!;
    const both = createLinkedProject({ "quickservicets.config.ts": config(), "endpoints/github/webhook.ts": webhook, "endpoints/github/post.ts": "export default () => ({});\n" });
    await expect(build(both)).rejects.toThrow("endpoints/github/post.ts and endpoints/github/webhook.ts: a folder has one POST route; keep one of them");
    const off = createLinkedProject({ "quickservicets.config.ts": config(""), "endpoints/github/webhook.ts": webhook });
    await expect(build(off)).rejects.toThrow("endpoints/github/webhook.ts needs webhooks: {} in quickservicets.config.ts");
    const plain = createLinkedProject({ "quickservicets.config.ts": config(), "endpoints/github/webhook.ts": "export default () => ({});\n" });
    await expect(build(plain)).rejects.toThrow("endpoints/github/webhook.ts: must default-export defineWebhook(...)");
  });
});
