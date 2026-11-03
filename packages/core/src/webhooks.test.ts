import { describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entityModel, field } from "./entity-model.ts";
import { DeliverableEvents, entityDeliveries, patternsOverlap } from "./features/webhooks/deliverable.ts";
import { generateSecret } from "./features/webhooks/subscriptions.ts";
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
