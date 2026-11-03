import { describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entityModel, field } from "./entity-model.ts";
import { DeliverableEvents, entityDeliveries, patternsOverlap } from "./features/webhooks/deliverable.ts";
import { generateSecret } from "./features/webhooks/subscriptions.ts";
import { CACHE_REFRESH_MS, subscriptionCache } from "./features/webhooks/cache.ts";
import { retryDelay } from "./features/webhooks/retries.ts";
import { deliveryLog } from "./features/webhooks/log.ts";
import { receiptStore, webhookReceiptEntity } from "./features/webhooks/receipts.ts";
import { webhookDeliveryEntity } from "./features/webhooks/deliveries.ts";
import { webhookSubscriptionEntity } from "./features/webhooks/models.ts";
import webhooksFeature from "./features/webhooks/index.ts";
import type { EntityModel, ParsedTags } from "./model.ts";

const resolve = (webhooks: unknown, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  resolveConfig({ database: memoryAdapter(), webhooks, ...extra } as ServiceConfig, env);
const optionsOf = (config: ReturnType<typeof resolve>) => config.features.find((feature) => feature.key === "webhooks")!.options as unknown as { events: string[]; delivery: Record<string, unknown> };

describe("options", () => {
  test("webhooks: {} enables events and queues with their defaults and resolves every default", () => {
    const config = resolve({});
    expect(config.features.map((feature) => feature.key)).toEqual(expect.arrayContaining(["webhooks", "events", "queues", "http"]));
    expect(config.enabledBy).toMatchObject({ events: ["webhooks"], queues: ["webhooks"] });
    expect(optionsOf(config)).toMatchObject({
      events: [],
      routes: { enabled: true, path: "/webhooks", roles: ["admin"] },
      delivery: { timeout: "10s", retrySchedule: ["5s", "5m", "30m", "2h", "5h", "10h", "10h"], disableAfter: "5d", responseBodyLimit: "1KB", retention: "30d", concurrency: 10 },
      incoming: { tolerance: "5m", maxBodySize: "1MB", dedupe: { enabled: true, retention: "7d" } },
    });
    expect(webhooksFeature.requires.map((requirement) => requirement.name)).toEqual(["http"]);
    // A project that configured queues keeps its own options.
    expect(resolve({}, {}, { queues: { concurrency: 4 } }).features.find((feature) => feature.key === "queues")!.options).toMatchObject({ concurrency: 4 });
    expect(resolve(undefined).features.some((feature) => ["webhooks", "events", "queues"].includes(feature.key))).toBe(false);
  });

  test("requireHttps is unset unless given, so production decides; events patterns are validated at resolution", () => {
    expect(optionsOf(resolve({})).delivery).not.toHaveProperty("requireHttps", true);
    expect(optionsOf(resolve({ delivery: { requireHttps: true } })).delivery).toMatchObject({ requireHttps: true });
    expect(optionsOf(resolve({ events: ["invoice.*", "*.created", "*"] })).events).toEqual(["invoice.*", "*.created", "*"]);
    expect(() => resolve({ events: ["invoice.*", "bad pattern"] })).toThrow("Invalid webhooks.events[1]: bad pattern is not an event pattern");
    expect(() => resolve({ events: ["single"] })).toThrow("Invalid webhooks.events[0]");
  });
});

const tagged = (model: EntityModel, tags: ParsedTags): EntityModel => ({ ...model, tags });
const order = entityModel("Order", { status: field({ type: "string" }) });
const user = entityModel("User", { name: field({ type: "string" }) });

describe("deliverable events", () => {
  const defaults = { events: ["created", "updated", "deleted"] as const };
  test("the option's patterns plus the operations of tagged entities, never webhook events", () => {
    const deliverable = new DeliverableEvents(["invoice.*"], entityDeliveries([tagged(order, { webhooks: { on: true, options: { events: ["created"] } } }), user], { events: [...defaults.events] }));
    expect(deliverable.isDeliverable("order.created")).toBe(true);
    expect(deliverable.isDeliverable("invoice.paid")).toBe(true);
    expect(deliverable.isDeliverable("order.updated")).toBe(false);
    expect(deliverable.isDeliverable("user.created")).toBe(false);
    expect(deliverable.isDeliverable("webhook.delivery.failed")).toBe(false);
    expect(deliverable.listenedPatterns().sort()).toEqual(["invoice.*", "order.created"]);
    expect(deliverable.matchesAny("order.*")).toBe(true);
    expect(deliverable.matchesAny("order.written")).toBe(true);
    expect(deliverable.matchesAny("invoice.paid")).toBe(true);
    expect(deliverable.matchesAny("*.paid")).toBe(true);
    expect(deliverable.matchesAny("user.created")).toBe(false);
    expect(deliverable.matchesAny("order.deleted")).toBe(false);
    expect(deliverable.matchesAny("webhook.ping")).toBe(false);
  });

  test("a bare tag delivers every operation; option patterns reach untagged entities and custom events, but not webhook ones", () => {
    const deliverable = new DeliverableEvents(["*.created", "*"], entityDeliveries([tagged(order, { webhooks: { on: true, options: {} } }), user], { events: [...defaults.events] }));
    expect(deliverable.isDeliverable("order.deleted")).toBe(true);
    expect(deliverable.isDeliverable("user.created")).toBe(true);
    expect(deliverable.isDeliverable("anything.custom")).toBe(true);
    expect(deliverable.isDeliverable("webhook.ping")).toBe(false);
    const only = new DeliverableEvents(["webhook.*"], entityDeliveries([user], { events: [...defaults.events] }));
    expect(only.matchesAny("webhook.ping")).toBe(false);
    expect(only.isDeliverable("webhook.ping")).toBe(false);
    // Custom event patterns never match write events of entities that do not exist.
    expect(new DeliverableEvents(["*.created"], []).matchesAny("ghost.created")).toBe(false);
  });

  test("patterns overlap when they share a type", () => {
    expect(patternsOverlap("invoice.*", "invoice.paid")).toBe(true);
    expect(patternsOverlap("*.paid", "invoice.*")).toBe(true);
    expect(patternsOverlap("invoice.paid", "order.paid")).toBe(false);
    expect(patternsOverlap("a.b.c", "a.*")).toBe(false);
    expect(patternsOverlap("*", "a.b")).toBe(true);
    expect(patternsOverlap("order.written", "*.deleted")).toBe(true);
  });
});

describe("secrets", () => {
  test("a secret is whsec_ and the base64 of 24 random bytes", () => {
    const secrets = new Set(Array.from({ length: 20 }, generateSecret));
    expect(secrets.size).toBe(20);
    for (const secret of secrets) {
      expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
      expect(Buffer.from(secret.slice(6), "base64")).toHaveLength(24);
    }
  });
});

describe("the subscription cache", () => {
  const subscription = (id: string, events: string[], tenant?: string, enabled = true) =>
    ({ id, url: "https://hooks.example", events, enabled, secret: "whsec_x", ...(tenant ? { tenant } : {}), createdAt: new Date(), updatedAt: new Date() }) as never;
  const logger = { info() {}, warn() {}, error() {} };

  test("groups enabled subscriptions by tenant and matches their patterns", async () => {
    const rows = [subscription("a", ["order.*"]), subscription("b", ["order.created"], "acme"), subscription("c", ["*"], "acme", false)];
    const cache = subscriptionCache({ load: async () => rows, logger });
    await cache.refresh();
    expect(cache.matching("order.created", undefined).map((row: { id: string }) => row.id)).toEqual(["a"]);
    expect(cache.matching("order.created", "acme").map((row: { id: string }) => row.id)).toEqual(["b"]);
    expect(cache.matching("order.deleted", "acme")).toEqual([]);
    expect(cache.matching("order.created", "globex")).toEqual([]);
  });

  test("another worker's subscription is seen once the 30-second refresh is due (fake clock)", async () => {
    const rows: never[] = [];
    let now = 1_000_000;
    let loads = 0;
    const cache = subscriptionCache({ load: async () => (loads++, [...rows]), logger, now: () => now });
    await cache.refresh();
    rows.push(subscription("a", ["order.created"]));
    now += CACHE_REFRESH_MS - 1;
    cache.refreshIfDue();
    await Bun.sleep(0);
    expect(cache.matching("order.created", undefined)).toEqual([]);
    now += 1;
    cache.refreshIfDue();
    await cache.refresh();
    expect(cache.matching("order.created", undefined)).toHaveLength(1);
    expect(loads).toBeGreaterThanOrEqual(2);
  });
});

describe("the retry schedule", () => {
  const schedule = ["5s", "5m", "30m", "2h", "5h", "10h", "10h"];
  test("each retry waits its entry with up to 10% jitter, and the default gives 8 attempts over about 27.6 hours", () => {
    expect(retryDelay(schedule, 1, () => 0.5)).toBe(5000);
    expect(retryDelay(schedule, 1, () => 0)).toBe(4500);
    expect(retryDelay(schedule, 1, () => 1)).toBe(5500);
    expect(retryDelay(schedule, 2, () => 0.5)).toBe(300_000);
    expect(retryDelay(schedule, 7, () => 0.5)).toBe(36_000_000);
    expect(retryDelay(schedule, 8, () => 0.5)).toBeNull();
    const total = schedule.reduce((sum, _entry, index) => sum + retryDelay(schedule, index + 1, () => 0.5)!, 0);
    expect(total / 3_600_000).toBeCloseTo(27.6, 0);
  });

  test("an empty schedule or an entry above 7d fails resolution", () => {
    const message = "Invalid webhooks.delivery.retrySchedule: expected 1 to 20 durations of at most 7d";
    expect(() => resolve({ delivery: { retrySchedule: [] } })).toThrow(message);
    expect(() => resolve({ delivery: { retrySchedule: ["8d"] } })).toThrow(message);
    expect(() => resolve({ delivery: { retrySchedule: Array.from({ length: 21 }, () => "1s") } })).toThrow(message);
    expect(optionsOf(resolve({ delivery: { retrySchedule: ["7d"] } })).delivery).toMatchObject({ retrySchedule: ["7d"] });
  });
});

describe("delivery retention", () => {
  test("finished deliveries past the retention are deleted in batches; pending ones are kept at any age", async () => {
    const model = webhookDeliveryEntity();
    const adapter = memoryAdapter();
    await adapter.connect([webhookSubscriptionEntity(), model]);
    const now = Date.parse("2026-11-03T10:00:00Z");
    const DAY = 86_400_000;
    const insert = (status: string, ageDays: number) => {
      const at = new Date(now - ageDays * DAY);
      return adapter.insert(model, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, subscription: "s", event: Bun.randomUUIDv7(), type: "order.created", payload: {}, status, attempt: 1 } as never);
    };
    const old = await insert("succeeded", 31);
    const oldFailed = await insert("failed", 31);
    const recent = await insert("failed", 29);
    const pending = await insert("pending", 40);
    const delivering = await insert("delivering", 40);
    const logs: { message: string; count?: number }[] = [];
    const log = deliveryLog({ adapter, model, logger: { info: (entry) => void logs.push(entry as never), warn() {}, error() {} }, now: () => now });
    expect(await log.cleanup("30d")).toBe(2);
    const left = (await adapter.findMany(model, { where: [], sort: [], limit: 10, offset: 0 })).data.map((row) => row.id).sort();
    expect(left).toEqual([recent.id, pending.id, delivering.id].sort());
    expect(left).not.toContain(old.id);
    expect(left).not.toContain(oldFailed.id);
    expect(logs).toContainEqual(expect.objectContaining({ message: "webhooks.cleanup", count: 2 }));
    expect(await log.cleanup("7d")).toBe(1);
    expect(optionsOf(resolve({}, { QS_WEBHOOKS_DELIVERY_RETENTION: "7d" })).delivery).toMatchObject({ retention: "7d" });
  });
});

describe("incoming receipts", () => {
  test("a claim inserts a receipt once; receipts older than the retention are deleted, newer ones kept (fake clock)", async () => {
    const model = webhookReceiptEntity();
    const adapter = memoryAdapter();
    await adapter.connect([model]);
    let now = Date.parse("2026-11-03T10:00:00Z");
    const logs: { message: string; count?: number }[] = [];
    const store = receiptStore({ adapter, model, logger: { info: (entry) => void logs.push(entry as never), warn() {}, error() {} }, now: () => now });
    const old = await store.claim({ endpoint: "/stripe", deliveryId: "old" });
    expect(old.kind).toBe("claimed");
    expect((await store.claim({ endpoint: "/stripe", deliveryId: "old" })).kind).toBe("busy");
    expect((await store.claim({ endpoint: "/stripe", deliveryId: "old", tenant: "acme" })).kind).toBe("claimed");
    now += 2 * 86_400_000;
    await store.claim({ endpoint: "/stripe", deliveryId: "recent" });
    now += 6 * 86_400_000;
    expect(await store.cleanup("7d")).toBe(2);
    const left = (await adapter.findMany(model, { where: [], sort: [], limit: 10, offset: 0 })).data.map((row) => row.deliveryId);
    expect(left).toEqual(["recent"]);
    expect(logs).toContainEqual(expect.objectContaining({ message: "webhooks.receipts.cleanup", count: 2 }));
  });
});
