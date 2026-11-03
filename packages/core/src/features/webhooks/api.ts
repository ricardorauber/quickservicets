import type { WebhookSubscriptions } from "./subscriptions.ts";

/** The feature API of `webhooks`, reached with `ctx.feature("webhooks")`, and the core's `webhooks` export. */
export interface WebhooksApi {
  /** Creates, lists, reads, changes, deletes and rotates the secret of subscriptions. */
  subscriptions: WebhookSubscriptions;
}
