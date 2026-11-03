import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signWebhook } from "../../packages/core/src/index.ts";

const content = join(import.meta.dir, "../src/content/docs");
const guide = readFileSync(join(content, "guides/webhooks.md"), "utf8");
const recipe = readFileSync(join(content, "recipes/receive-stripe-webhooks.md"), "utf8");

describe("the webhooks guide", () => {
  test("it covers every topic, from deliverable events to every customization level", () => {
    for (const topic of [
      "## Deliverable events",
      "## Deliveries",
      "## Sending and signatures",
      "## Retries and auto-disable",
      "## Delivery log and resend",
      "## Subscriptions from code",
      "## Management routes",
      "## Tenants",
      "## Incoming webhooks",
      "## Dedupe and asynchronous handling",
      "## Customization",
    ]) {
      expect(guide).toContain(topic);
    }
    for (const item of ["requireHttps", "SSRF", "rotateSecret", "at least once", "webhook-id", "Failing for more than 5d", "quickservicets webhooks resend", "retention", "stripeSignature", "githubSignature", "standardWebhookSignature", "hmacSignature", "async: true", "@webhooks fields=", "delivery.headers", "beforeDeliver", "sender", "eject webhooks", "examples/minimal/webhooks"]) {
      expect(guide).toContain(item);
    }
  });

  test("the receiver snippet verifies a signature the native produces", async () => {
    const snippet = /```ts\n(import \{ verifyWebhook \} from "@quickservicets\/core";\n\nexport async function receive[\s\S]*?)\n```/.exec(guide)![1]!;
    const dir = mkdtempSync(join(tmpdir(), "webhooks-guide-"));
    try {
      const file = join(dir, "receive.ts");
      writeFileSync(file, snippet.replace('"@quickservicets/core"', JSON.stringify(join(import.meta.dir, "../../packages/core/src/index.ts"))));
      const { receive } = (await import(file)) as { receive: (request: Request, secret: string) => Promise<Response> };
      const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
      const body = JSON.stringify({ id: "evt_1", type: "order.created", data: {} });
      const timestamp = Math.floor(Date.now() / 1000);
      const headers = { "webhook-id": "evt_1", "webhook-timestamp": String(timestamp), "webhook-signature": signWebhook({ id: "evt_1", timestamp, body, secret }) };
      expect((await receive(new Request("http://x/", { method: "POST", headers, body }), secret)).status).toBe(204);
      expect((await receive(new Request("http://x/", { method: "POST", headers, body: `${body} ` }), secret)).status).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the Stripe recipe and the links", () => {
  test("the recipe shows stripeSignature, the env secret, dedupe, async handling and the Stripe CLI", () => {
    for (const item of ["stripeSignature({ secret: env.STRIPE_WEBHOOK_SECRET })", "async: true", "duplicate", "stripe listen --forward-to localhost:3000/stripe"]) expect(recipe).toContain(item);
  });

  test("the configuration, events and queues guides and the guides index link to the webhooks guide", () => {
    for (const page of ["guides/configuration.md", "guides/events.md", "guides/queues.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/webhooks/)");
  });
});
