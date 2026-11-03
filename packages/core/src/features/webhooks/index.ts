import { defineFeature, HttpError, queues, safeLog, systemTarget, type Condition, type JobLogger, type Repositories } from "../public.ts";
import type { WebhooksApi } from "./api.ts";
import { DeliverableEvents, entityDeliveries, patternProblem } from "./deliverable.ts";
import { deliverer } from "./attempts.ts";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { incomingRunner, isWebhookDefinition, type IncomingMessage, type WebhookDefinition } from "./incoming.ts";
import { hasWebhookFiles, receiptStore, webhookReceiptEntity } from "./receipts.ts";
import { retryRule, RETRY_SCHEDULE_PROBLEM, validSchedule } from "./retries.ts";
import { CLEANUP_INTERVAL, deliveryLog } from "./log.ts";
import { DELIVER_QUEUE, INCOMING_QUEUE } from "./matching.ts";
import { webhooksCommands } from "./commands.ts";
import { webhookClock } from "./state.ts";
import { CACHE_REFRESH_MS, subscriptionCache } from "./cache.ts";
import { webhookDeliveryEntity } from "./deliveries.ts";
import { matchingListener } from "./matching.ts";
import { webhookSubscriptionEntity } from "./models.ts";
import { webhooksOptions, type WebhookOperation } from "./options.ts";
import { documentRoutes, registerRoutes, warnRoutesNeedAuth } from "./routes.ts";
import { running } from "./running.ts";
import { subscriptionStore, type SubscriptionStore } from "./subscriptions.ts";

/** The API of each running configuration, for its feature API. */
const apis = new WeakMap<object, WebhooksApi>();

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
      { name: "WebhookReceipt", placement: "feature", description: "One received incoming delivery per route, id and tenant, while incoming.dedupe is on and the project has a webhook.ts file." },
    ],
  },
  requires: ["http"],
  enables: ["events", "queues"],
  options: webhooksOptions,
  validate(options) {
    const problems = options.events.flatMap((pattern, index) => {
      const reason = patternProblem(pattern);
      return reason ? [`Invalid webhooks.events[${index}]: ${reason}`] : [];
    });
    if (!validSchedule(options.delivery.retrySchedule)) problems.push(RETRY_SCHEDULE_PROBLEM);
    return problems;
  },
  // Receipts of incoming deliveries exist only while dedupe is on and the project has a webhook.ts file.
  entities: ({ options, root }) => [
    webhookSubscriptionEntity(),
    webhookDeliveryEntity(),
    ...(options.incoming.dedupe.enabled && root !== undefined && hasWebhookFiles(join(root, "endpoints")) ? [webhookReceiptEntity()] : []),
  ],
  commands: webhooksCommands,
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
    const retries = retryRule({
      adapter,
      model: deliveryModel,
      store: subscriptions,
      schedule: ctx.options.delivery.retrySchedule,
      disableAfter: ctx.options.delivery.disableAfter,
      logger: ctx.logger,
      emit: (type, payload) => ctx.events.emit(type as never, payload as never),
    });
    const log = deliveryLog({ adapter, model: deliveryModel, logger: ctx.logger });
    /** A delivery whose subscription the caller's tenant scope may see. */
    const visibleDelivery = async (id: string) => {
      const delivery = await log.get(id);
      const notFound = () => new HttpError(404, `Webhook delivery ${id} not found`);
      if (!delivery) throw notFound();
      try {
        await subscriptions.api.get(String(delivery.subscription));
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw notFound();
        throw error;
      }
      return delivery;
    };
    // Every worker that runs scheduled work deletes old finished deliveries at startup and once an hour.
    if (ctx.worker.runsScheduledWork) {
      let cleanup: ReturnType<typeof setInterval> | undefined;
      const failed = (error: unknown) => {
        safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "webhooks.cleanup.failed", error: { message: (error as Error)?.message ?? String(error) } });
      };
      const clean = async () => {
        await log.cleanup(ctx.options.delivery.retention).catch(failed);
        if (receipts) await receipts.cleanup(ctx.options.incoming.dedupe.retention).catch(failed);
      };
      ctx.app.onStart(() => {
        void clean();
        cleanup = setInterval(() => void clean(), CLEANUP_INTERVAL);
        cleanup.unref?.();
      });
      ctx.app.onStop(() => clearInterval(cleanup));
    }
    const sender = deliverer({
      adapter,
      model: deliveryModel,
      store: subscriptions,
      delivery: ctx.options.delivery,
      logger: ctx.logger,
      failed: retries.failed,
      succeeded: retries.succeeded,
      disable: retries.disable,
    });
    const api: WebhooksApi = {
      subscriptions: {
        ...subscriptions.api,
        async ping(id: string) {
          // Read in the caller's tenant scope first, so another tenant's id is not found.
          await subscriptions.api.get(id);
          const stored = await subscriptions.stored(id);
          if (!stored) throw new HttpError(404, `Webhook subscription ${id} not found`);
          return sender.ping(stored);
        },
      },
      async resend(deliveryId) {
        const delivery = await visibleDelivery(deliveryId);
        const subscription = await subscriptions.stored(String(delivery.subscription));
        if (!subscription?.enabled) throw new HttpError(409, "Subscription is disabled", { code: "CONFLICT" });
        await log.reset(delivery);
        await queues.add(DELIVER_QUEUE as never, delivery.id as never, { dedupeKey: `${delivery.id}:resend:${Bun.randomUUIDv7()}` });
        return { id: delivery.id, status: "pending" };
      },
      async deliveries(subscriptionId, query) {
        await subscriptions.api.get(subscriptionId);
        return log.list(subscriptionId, query);
      },
      async delivery(subscriptionId, deliveryId) {
        await subscriptions.api.get(subscriptionId);
        const delivery = await log.get(deliveryId);
        if (!delivery || String(delivery.subscription) !== subscriptionId) throw new HttpError(404, `Webhook delivery ${deliveryId} not found`);
        return delivery;
      },
    };
    apis.set(ctx.options, api);
    // `webhook.ts` routes: the signature checked on the raw body before the hooks and `handle`.
    const receiptModel = ctx.options.incoming.dedupe.enabled ? ctx.models.find((candidate) => candidate.key === "WebhookReceipt" && candidate.system) : undefined;
    const receipts = receiptModel ? receiptStore({ adapter, model: receiptModel, logger: ctx.logger }) : undefined;
    const queuesOn = ctx.config.features.some((feature) => feature.key === "queues");
    const incoming = incomingRunner({
      logger: ctx.logger,
      settings: () => ({ tolerance: ctx.options.incoming.tolerance, maxBodySize: ctx.options.incoming.maxBodySize }),
      verifierNamed: () => undefined,
      receipts: () => receipts,
      ...(queuesOn ? { enqueue: (message: IncomingMessage) => queues.add(INCOMING_QUEUE as never, message as never) } : {}),
    });
    // The asynchronous routes' definitions, read from the build's routes when a consumer first needs one.
    let definitions: Promise<Map<string, WebhookDefinition>> | undefined;
    const definitionOf = async (route: string) => {
      definitions ??= (async () => {
        const file = resolve(ctx.generated("."), "..", "routes.ts");
        const found = new Map<string, WebhookDefinition>();
        if (!existsSync(file)) return found;
        const { endpoints = [] } = (await import(file)) as { endpoints?: { path: string; kind?: string; handler: unknown }[] };
        for (const endpoint of endpoints) if (endpoint.kind === "webhook" && isWebhookDefinition(endpoint.handler)) found.set(endpoint.path, endpoint.handler);
        return found;
      })();
      const definition = (await definitions).get(route);
      if (!definition) throw new Error(`No webhook.ts route POST ${route}`);
      return definition;
    };
    ctx.app.configureServer({ webhookRunner: incoming });
    // The management routes need authentication: without auth, subscriptions are managed from code only.
    if (ctx.options.routes.enabled) {
      if (authEnabled(ctx.config)) registerRoutes(ctx, ctx.options.routes, () => api, () => webhookClock.now());
      else warnRoutesNeedAuth(ctx.logger);
    }
    const deliveries = {
      deliver: (id: string, context: { signal: AbortSignal }) => sender.deliver(id, context),
      async incoming(message: IncomingMessage, context: { repos: Repositories; log: JobLogger }) {
        try {
          await incoming.consume(await definitionOf(message.route), message, context);
        } catch (error) {
          if (message.receipt) await receipts?.finish(message.receipt, "failed");
          throw error;
        }
        if (message.receipt) await receipts?.finish(message.receipt, "processed");
      },
    };
    running.current = api;
    running.deliveries = deliveries;
    ctx.app.onStop(() => {
      if (running.current === api) running.current = undefined;
      if (running.deliveries === deliveries) running.deliveries = undefined;
    });
  },
  api: (ctx): WebhooksApi => apis.get(ctx.options)!,
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
export { webhookClock } from "./state.ts";
export { DeliverableEvents, entityDeliveries, patternMatchesType, patternProblem, patternsOverlap } from "./deliverable.ts";
export { webhookSubscriptionEntity } from "./models.ts";
export { bodyOf, WEBHOOK_DELIVERY_STATUSES, MAX_PAYLOAD_BYTES, webhookDeliveryEntity } from "./deliveries.ts";
export { CACHE_REFRESH_MS, subscriptionCache } from "./cache.ts";
export type { WebhookDeliveryStatus, WebhookDelivery } from "./deliveries.ts";
export { generateSecret, PREVIOUS_SECRET_MS } from "./subscriptions.ts";
export { signWebhook, verifyWebhook } from "./signing.ts";
export { RECEIPT_LOCK_MS, webhookReceiptEntity } from "./receipts.ts";
export type { WebhookReceipt } from "./receipts.ts";
export type { IncomingMessage } from "./incoming.ts";
export { defineWebhook, githubSignature, hmacSignature, invalidSignature, isWebhookDefinition, standardWebhookSignature, stripeSignature } from "./incoming.ts";
export type { HmacSignatureOptions, WebhookDefinition, WebhookHandleContext, WebhookOptions, WebhookRejection, WebhookSecret, WebhookSecretValue, WebhookVerification, WebhookVerifier, WebhookVerifyInput } from "./incoming.ts";
export { GONE_REASON, PING_LIMIT } from "./attempts.ts";
export { MAX_RETRY_DELAY_MS, retryDelay } from "./retries.ts";
export { RESEND_LIMIT } from "./routes.ts";
export type { DeliveryListOptions, DeliveryPage, DeliverySummary } from "./log.ts";
export type { WebhookDeliveryEvent, WebhookSubscriptionDisabledEvent } from "./retries.ts";
export type { SignInput, VerifyInput } from "./signing.ts";
export type { WebhooksApi } from "./api.ts";
export type { CreateSubscriptionInput, SubscriptionListOptions, UpdateSubscriptionInput, WebhookSubscription, WebhookSubscriptions } from "./subscriptions.ts";
