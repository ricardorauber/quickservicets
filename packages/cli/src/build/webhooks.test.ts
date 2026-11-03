import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, registerProjectFeatures, runForTenant, webhooks, type EntityModel } from "@quickservicets/core";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

const config = (webhooksOption = "webhooks: {}", extra = "", adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ database: ${adapter}${webhooksOption ? `, ${webhooksOption}` : ""}${extra ? `, ${extra}` : ""} });
`;
const ORDER = "/** @webhooks created */\nexport type Order = { status: string; total: number };\n";
const files = (webhooksOption = 'webhooks: { events: ["invoice.*"] }', extra = "") => ({
  "quickservicets.config.ts": config(webhooksOption, extra),
  "entities/Order.ts": ORDER,
});

/** The error a rejected call threw, with its details. */
async function failure(promise: Promise<unknown>): Promise<{ status: number; message: string; details: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, message: error.message, details: error.details };
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("enabling the native", () => {
  test("webhooks: {} enables events and queues, adds WebhookSubscription without routes, and a project without it builds no webhook output", async () => {
    const service = await startTestService({ files: { ...files("webhooks: {}"), "entities/Order.ts": "export type Order = { status: string };\n" } });
    try {
      const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
      expect(models.find((model) => model.key === "WebhookSubscription")).toMatchObject({ internal: true, name: "webhook-subscriptions", repoKey: "webhookSubscriptions", tableName: "webhook_subscriptions" });
      expect((await service.fetch("/webhook-subscriptions")).status).toBe(404);
    } finally {
      await service.stop();
    }
    const without = createLinkedProject({ "quickservicets.config.ts": config(""), "entities/User.ts": "export type User = { name: string };\n" });
    const off = createLinkedProject({ "quickservicets.config.ts": config("webhooks: false"), "entities/User.ts": "export type User = { name: string };\n" });
    await build(without);
    await build(off);
    for (const file of readdirSync(join(without, ".generated"))) {
      const content = readFileSync(join(without, ".generated", file), "utf8");
      expect(content).not.toMatch(/Webhook|webhook_subscriptions|webhook-subscriptions/);
      expect(readFileSync(join(off, ".generated", file), "utf8")).toBe(content);
    }
  });

  test("migration add creates the webhook_subscriptions table with its tenant and enabled index", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config("webhooks: {}", "", 'sqliteAdapter({ path: ":memory:" })'), "entities/Order.ts": ORDER });
    const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?webhook_subscriptions/);
    expect(created).toMatch(/webhook_subscriptions_tenant_enabled/);
  });
});

describe("subscriptions from code", () => {
  test("create returns a whsec_ secret once; reads never show it again", async () => {
    const service = await startTestService({ files: files() });
    try {
      const created = await webhooks.subscriptions.create({ url: "https://hooks.example/a", events: ["order.created"], description: "orders" });
      expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
      expect(created).toMatchObject({ url: "https://hooks.example/a", events: ["order.created"], enabled: true, description: "orders" });
      const read = await webhooks.subscriptions.get(created.id);
      expect(read).not.toHaveProperty("secret");
      expect(read).not.toHaveProperty("previousSecret");
      const listed = await webhooks.subscriptions.list();
      expect(listed.total).toBe(1);
      expect(listed.data[0]).not.toHaveProperty("secret");
      // The repository of the internal entity is writable, and its secret is stored.
      const stored = (await (service.repos as unknown as { webhookSubscriptions: { findById(id: string): Promise<Record<string, unknown>> } }).webhookSubscriptions.findById(created.id));
      expect(stored).toBeDefined();
    } finally {
      await service.stop();
    }
  });

  test("URL and events validation answer 400 with the field and the reason", async () => {
    const service = await startTestService({ files: files('webhooks: { events: ["invoice.*"], delivery: { requireHttps: true } }') });
    try {
      const create = (url: string, events = ["order.created"]) => failure(webhooks.subscriptions.create({ url, events }));
      expect(await create("http://hooks.example/a")).toMatchObject({ status: 400, details: [{ field: "url", message: "Must be an https URL" }] });
      expect(await create("https://u:p@hooks.example")).toMatchObject({ status: 400, details: [{ field: "url", message: "Must not contain credentials" }] });
      expect(await create("https://127.0.0.1/x")).toMatchObject({ status: 400, details: [{ field: "url", message: "Address is not allowed" }] });
      expect(await create("https://hooks.example/a", ["user.created"])).toMatchObject({ status: 400, details: [{ field: "events", message: "Event user.created is not available for webhooks" }] });
      expect(await create("https://hooks.example/a", [])).toMatchObject({ status: 400, details: [{ field: "events", message: "Is required" }] });
      expect(await create("https://hooks.example/a", ["webhook.ping"])).toMatchObject({ details: [{ field: "events", message: "Event webhook.ping is not available for webhooks" }] });
      expect(await create("https://hooks.example/a", ["order.updated"])).toMatchObject({ details: [{ field: "events", message: "Event order.updated is not available for webhooks" }] });
      // Custom events through the option's patterns, and entity patterns.
      await webhooks.subscriptions.create({ url: "https://hooks.example/a", events: ["invoice.paid", "invoice.*", "order.*", "*"] });
      // Updating the URL checks it again.
      const created = await webhooks.subscriptions.create({ url: "https://hooks.example/b", events: ["order.created"] });
      expect(await failure(webhooks.subscriptions.update(created.id, { url: "https://10.0.0.1/" }))).toMatchObject({ details: [{ field: "url", message: "Address is not allowed" }] });
    } finally {
      await service.stop();
    }
    const outside = await startTestService({ files: files() });
    try {
      // Outside production http URLs are accepted.
      await expect(webhooks.subscriptions.create({ url: "http://hooks.example/a", events: ["order.created"] })).resolves.toMatchObject({ url: "http://hooks.example/a" });
    } finally {
      await outside.stop();
    }
  });

  test("rotateSecret keeps the old secret for 24 hours; enabling clears why a subscription was disabled; delete removes it", async () => {
    const service = await startTestService({ files: files() });
    try {
      const created = await webhooks.subscriptions.create({ url: "https://hooks.example/a", events: ["order.created"] });
      const before = Date.now();
      const rotated = await webhooks.subscriptions.rotateSecret(created.id);
      expect(rotated.secret).toMatch(/^whsec_/);
      expect(rotated.secret).not.toBe(created.secret);
      expect(rotated.previousSecretExpiresAt.getTime() - before).toBeGreaterThanOrEqual(24 * 3_600_000 - 1000);
      expect(rotated.previousSecretExpiresAt.getTime() - before).toBeLessThanOrEqual(24 * 3_600_000 + 1000);
      const repo = (service.repos as unknown as { webhookSubscriptions: { findById(id: string): Promise<Record<string, unknown>>; update(id: string, changes: object): Promise<unknown> } }).webhookSubscriptions;
      // The repository leaves the hidden secrets out of what it reads.
      expect(await repo.findById(created.id)).not.toHaveProperty("secret");
      await repo.update(created.id, { enabled: false, disabledReason: "Receiver answered 410 Gone", failingSince: new Date() });
      const enabled = await webhooks.subscriptions.update(created.id, { enabled: true, description: "back" });
      expect(enabled).toMatchObject({ enabled: true, disabledReason: null, failingSince: null, description: "back" });
      await webhooks.subscriptions.delete(created.id);
      expect(await failure(webhooks.subscriptions.get(created.id))).toMatchObject({ status: 404, message: `Webhook subscription ${created.id} not found` });
    } finally {
      await service.stop();
    }
  });

  test("with tenancy, a subscription of acme is invisible from globex", async () => {
    const service = await startTestService({ files: files('webhooks: { events: ["invoice.*"] }', 'tenancy: { source: "config", tenants: { acme: {}, globex: {} } }') });
    try {
      const created = await runForTenant("acme", () => webhooks.subscriptions.create({ url: "https://hooks.example/a", events: ["order.created"], createdBy: "u1" }));
      expect(created).toMatchObject({ tenant: "acme", createdBy: "u1" });
      expect((await runForTenant("acme", () => webhooks.subscriptions.list())).total).toBe(1);
      expect((await runForTenant("globex", () => webhooks.subscriptions.list())).total).toBe(0);
      for (const call of [(): Promise<unknown> => webhooks.subscriptions.get(created.id), () => webhooks.subscriptions.update(created.id, { description: "x" }), () => webhooks.subscriptions.rotateSecret(created.id), () => webhooks.subscriptions.delete(created.id)]) {
        expect(await failure(runForTenant("globex", call))).toMatchObject({ status: 404, message: `Webhook subscription ${created.id} not found` });
      }
      await expect(runForTenant("acme", () => webhooks.subscriptions.get(created.id))).resolves.toMatchObject({ id: created.id });
    } finally {
      await service.stop();
    }
  });
});
