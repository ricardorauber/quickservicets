import { queues, safeLog, systemTarget, type AnyEvent, type DatabaseAdapter, type EntityModel, type Logger, type StoredRecord } from "../public.ts";
import type { SubscriptionCache } from "./cache.ts";
import type { DeliverableEvents } from "./deliverable.ts";
import { bodyOf, MAX_PAYLOAD_BYTES } from "./deliveries.ts";
import { webhookClock } from "./state.ts";

/** The queue each delivery attempt runs in. */
export const DELIVER_QUEUE = "webhooks/deliver";

/** The queue asynchronous incoming webhooks run in. */
export const INCOMING_QUEUE = "webhooks/incoming";

/** What the matching listener needs. */
export interface MatchingOptions {
  adapter: DatabaseAdapter;
  model: EntityModel;
  deliverable: DeliverableEvents;
  cache: SubscriptionCache;
  logger: Logger;
  now?: () => number;
}

/**
 * The listener that turns each deliverable event into one `pending` delivery per matching subscription of its tenant,
 * each handed to the `webhooks/deliver` queue inside the write's transaction; an event several patterns match is
 * handled once.
 */
export function matchingListener(options: MatchingOptions): (event: AnyEvent) => Promise<void> {
  const now = options.now ?? (() => webhookClock.now());
  const handled = new WeakSet<object>();
  return async (event) => {
    if (handled.has(event)) return;
    handled.add(event);
    const subscriptions = options.cache.matching(event.type, event.actor?.tenant);
    if (subscriptions.length === 0 || !options.deliverable.isDeliverable(event.type)) return;
    const payload = bodyOf(event, options.deliverable.entityOf(event.type));
    const size = Buffer.byteLength(JSON.stringify(payload));
    const tooLarge = size > MAX_PAYLOAD_BYTES;
    if (tooLarge) safeLog(options.logger, "warn", { timestamp: new Date(now()).toISOString(), message: "webhook.delivery.too-large", type: event.type, size });
    const { adapter } = systemTarget(options.adapter, options.model);
    for (const subscription of subscriptions) {
      const at = new Date(now());
      const row: StoredRecord = {
        id: Bun.randomUUIDv7(),
        createdAt: at,
        updatedAt: at,
        subscription: subscription.id,
        event: event.id,
        type: event.type,
        payload: tooLarge ? {} : payload,
        status: tooLarge ? "failed" : "pending",
        attempt: 0,
        ...(tooLarge ? { lastError: "Payload too large" } : {}),
        ...(subscription.tenant ? { tenant: subscription.tenant } : {}),
      };
      const delivery = await adapter.insert(options.model, row);
      if (!tooLarge) await queues.add(DELIVER_QUEUE as never, delivery.id as never, { dedupeKey: delivery.id });
    }
  };
}
