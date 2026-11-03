import type { DeliveryListOptions, DeliveryPage } from "./log.ts";
import type { WebhookDelivery } from "./deliveries.ts";
import type { WebhookSubscriptions } from "./subscriptions.ts";

/** The feature API of `webhooks`, reached with `ctx.feature("webhooks")`, and the core's `webhooks` export. */
export interface WebhooksApi {
  /** Creates, lists, reads, changes, deletes and rotates the secret of subscriptions. */
  subscriptions: WebhookSubscriptions;
  /**
   * Sends a finished (`succeeded` or `failed`) delivery again at once, from attempt 0 and with the same `webhook-id`;
   * throws 409 `Delivery is already scheduled` for a pending or delivering one and 409 `Subscription is disabled`.
   */
  resend(deliveryId: string): Promise<{ id: string; status: "pending" }>;
  /** The deliveries of a subscription, newest first, as the delivery log route lists them. */
  deliveries(subscriptionId: string, options?: DeliveryListOptions): Promise<DeliveryPage>;
  /** One delivery of a subscription, with its body and the response kept; throws `Webhook delivery <id> not found`. */
  delivery(subscriptionId: string, deliveryId: string): Promise<WebhookDelivery>;
}
