import { defineFeature, systemTarget, type Condition } from "../public.ts";
import type { WebhooksApi } from "./api.ts";
import { DeliverableEvents, entityDeliveries, patternProblem } from "./deliverable.ts";
import { CACHE_REFRESH_MS, subscriptionCache } from "./cache.ts";
import { webhookDeliveryEntity } from "./deliveries.ts";
import { matchingListener } from "./matching.ts";
import { webhookSubscriptionEntity } from "./models.ts";
import { webhooksOptions, type WebhookOperation } from "./options.ts";
import { documentRoutes, registerRoutes, warnRoutesNeedAuth } from "./routes.ts";
import { running } from "./running.ts";
import { subscriptionStore, type SubscriptionStore } from "./subscriptions.ts";

/** The subscription store of each running configuration, for its feature API. */
const stores = new WeakMap<object, SubscriptionStore>();

/**
 * The `webhooks` native: outgoing webhooks signed by the Standard Webhooks scheme for the events subscriptions choose,
 * and incoming webhook routes. Off unless `webhooks: {}` (or `QS_WEBHOOKS_ENABLED=true`) is set; it turns on `events`
 * and `queues` with their defaults when the project did not configure them.
 */
const webhooksFeature = defineFeature({
  key: "webhooks",
  docs: {
    summary: "Outgoing webhooks signed by the Standard Webhooks scheme for the events subscriptions choose, and incoming webhook routes.",
    entities: [
      { name: "WebhookSubscription", placement: "feature", description: "The subscriptions: a URL, the event patterns, the secret and the tenant." },
      { name: "WebhookDelivery", placement: "feature", description: "One delivery of an event to a subscription, created in the transaction of the write that caused it, with the outcome of its last attempt." },
    ],
  },
  requires: ["http"],
  enables: ["events", "queues"],
  options: webhooksOptions,
  validate(options) {
    return options.events.flatMap((pattern, index) => {
      const reason = patternProblem(pattern);
      return reason ? [`Invalid webhooks.events[${index}]: ${reason}`] : [];
    });
  },
  entities: () => [webhookSubscriptionEntity(), webhookDeliveryEntity()],
  tags: {
    webhooks: {
      on: ["entity"],
      scope: "entity",
      options: ["events"],
      shorthand: "events",
      description: "`@webhooks` makes the entity's write events deliverable to subscriptions, `@webhooks created,updated` only those operations, and `@webhooks off` none of them.",
      example: "/** @webhooks created,updated */\nexport type Order = { status: string; total: number };",
    },
  },
  setup(ctx) {
    const model = ctx.models.find((candidate) => candidate.key === "WebhookSubscription");
    if (!model) throw new Error("The webhooks native needs the WebhookSubscription entity; run quickservicets build after enabling it");
    const deliveryModel = ctx.models.find((candidate) => candidate.key === "WebhookDelivery" && candidate.system);
    if (!deliveryModel) throw new Error("The webhooks native needs the WebhookDelivery entity; run quickservicets build after enabling it");
    const deliverable = new DeliverableEvents(ctx.options.events, entityDeliveries(ctx.models, { events: ctx.options.entity.events as WebhookOperation[] }));
    const adapter = ctx.config.database;
    // The enabled subscriptions of this worker, so matching an event reads no database.
    let store: SubscriptionStore | undefined;
    const cache = subscriptionCache({ load: () => store!.enabled(), logger: ctx.logger });
    store = subscriptionStore({
      adapter,
      model,
      requireHttps: ctx.options.delivery.requireHttps ?? ctx.config.production,
      deliverable,
      logger: ctx.logger,
      changed: () => cache.refresh(),
      deleting: async (id) => {
        const target = systemTarget(adapter, deliveryModel).adapter;
        const where = [{ field: "subscription", op: "eq", value: id } as Condition];
        for (;;) {
          const { data } = await target.findMany(deliveryModel, { where, sort: [{ field: "id", direction: "asc" }], limit: 1000, offset: 0, withTotal: false });
          for (const row of data) await target.deleteById(deliveryModel, row.id);
          if (data.length < 1000) return;
        }
      },
    });
    const subscriptions = store;
    // One in-transaction listener per deliverable pattern: writes of other entities never reach the native.
    const listener = matchingListener({ adapter, model: deliveryModel, deliverable, cache, logger: ctx.logger });
    for (const pattern of deliverable.listenedPatterns()) ctx.events.on(pattern, listener as never, { phase: "inTransaction" });
    let refresh: ReturnType<typeof setInterval> | undefined;
    ctx.app.onStart(async () => {
      await cache.refresh();
      refresh = setInterval(() => cache.refreshIfDue(), CACHE_REFRESH_MS);
      refresh.unref?.();
    });
    ctx.app.onStop(() => clearInterval(refresh));
    stores.set(ctx.options, subscriptions);
    const api: WebhooksApi = { subscriptions: subscriptions.api };
    // The management routes need authentication: without auth, subscriptions are managed from code only.
    if (ctx.options.routes.enabled) {
      if (authEnabled(ctx.config)) registerRoutes(ctx, ctx.options.routes, () => subscriptions.api);
      else warnRoutesNeedAuth(ctx.logger);
    }
    // Sending arrives with the signed delivery; until then attempts leave deliveries pending.
    const deliveries = { deliver: async () => undefined };
    running.current = api;
    running.deliveries = deliveries;
    ctx.app.onStop(() => {
      if (running.current === api) running.current = undefined;
      if (running.deliveries === deliveries) running.deliveries = undefined;
    });
  },
  api: (ctx): WebhooksApi => ({ subscriptions: stores.get(ctx.options)!.api }),
  openapi(doc, { config, options }) {
    if (!options.routes.enabled || !authEnabled(config)) return doc;
    return documentRoutes(doc, options.routes);
  },
});

/** Whether the project's config enables the `auth` native. */
function authEnabled(config: { features: readonly { key: string }[] }): boolean {
  return config.features.some((feature) => feature.key === "auth");
}

export default webhooksFeature;
export { webhooksFeature };
export { webhooks } from "./running.ts";
export { DeliverableEvents, entityDeliveries, patternMatchesType, patternProblem, patternsOverlap } from "./deliverable.ts";
export { webhookSubscriptionEntity } from "./models.ts";
export { bodyOf, WEBHOOK_DELIVERY_STATUSES, MAX_PAYLOAD_BYTES, webhookDeliveryEntity } from "./deliveries.ts";
export { CACHE_REFRESH_MS, subscriptionCache } from "./cache.ts";
export type { WebhookDeliveryStatus, WebhookDelivery } from "./deliveries.ts";
export { generateSecret, PREVIOUS_SECRET_MS } from "./subscriptions.ts";
export type { WebhooksApi } from "./api.ts";
export type { CreateSubscriptionInput, SubscriptionListOptions, UpdateSubscriptionInput, WebhookSubscription, WebhookSubscriptions } from "./subscriptions.ts";
