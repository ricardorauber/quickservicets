import { defineFeature } from "../public.ts";
import type { WebhooksApi } from "./api.ts";
import { DeliverableEvents, entityDeliveries, patternProblem } from "./deliverable.ts";
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
    entities: [{ name: "WebhookSubscription", placement: "feature", description: "The subscriptions: a URL, the event patterns, the secret and the tenant." }],
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
  entities: () => [webhookSubscriptionEntity()],
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
    const deliverable = new DeliverableEvents(ctx.options.events, entityDeliveries(ctx.models, { events: ctx.options.entity.events as WebhookOperation[] }));
    const store = subscriptionStore({
      adapter: ctx.config.database,
      model,
      requireHttps: ctx.options.delivery.requireHttps ?? ctx.config.production,
      deliverable,
      logger: ctx.logger,
    });
    stores.set(ctx.options, store);
    const api: WebhooksApi = { subscriptions: store.api };
    // The management routes need authentication: without auth, subscriptions are managed from code only.
    if (ctx.options.routes.enabled) {
      if (authEnabled(ctx.config)) registerRoutes(ctx, ctx.options.routes, () => store.api);
      else warnRoutesNeedAuth(ctx.logger);
    }
    running.current = api;
    ctx.app.onStop(() => {
      if (running.current === api) running.current = undefined;
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
export { generateSecret, PREVIOUS_SECRET_MS } from "./subscriptions.ts";
export type { WebhooksApi } from "./api.ts";
export type { CreateSubscriptionInput, SubscriptionListOptions, UpdateSubscriptionInput, WebhookSubscription, WebhookSubscriptions } from "./subscriptions.ts";
