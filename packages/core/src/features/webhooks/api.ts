import type { DeliveryListOptions, DeliveryPage } from "./log.ts";
import type { WebhookDelivery } from "./deliveries.ts";
import type { FeatureHook } from "../public.ts";
import type { WebhookHandleContext, WebhookVerifier } from "./incoming.ts";
import type { StoredSubscription, WebhookSubscription, WebhookSubscriptions } from "./subscriptions.ts";

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

/** The setup API of `webhooks` (`ctx.feature("webhooks")`): the runtime API, hooks and named verifiers. */
export interface WebhooksSetupApi extends WebhooksApi {
  /** Appends a hook after the config's: `beforeDeliver`, `afterDeliver`, `onDisabled`, `beforeHandle` or `afterHandle`. */
  addHook<K extends keyof WebhookHooks>(name: K, fn: WebhookHooks[K]): void;
  /** Registers a verifier `webhook.ts` files name with `verify: "<name>"`, during setup only. */
  verifier(name: string, verifier: WebhookVerifier): void;
}

/** What `beforeDeliver` hooks receive: they may return a changed `body` or `headers`. */
export interface BeforeDeliver {
  subscription: WebhookSubscription;
  delivery: WebhookDelivery;
  body: unknown;
  headers: Record<string, string>;
}

/** What `afterDeliver` hooks receive after each attempt. */
export interface AfterDeliver {
  subscription: WebhookSubscription;
  delivery: WebhookDelivery;
  /** The receiver's status, 0 without an answer. */
  status: number;
  ok: boolean;
  durationMs: number;
}

/** What `onDisabled` hooks receive. */
export interface OnDisabled {
  subscription: WebhookSubscription;
  reason: string;
}

/** What `beforeHandle` hooks receive: they may return a changed `event`. */
export interface BeforeHandle {
  event: unknown;
  ctx: WebhookHandleContext;
}

/** What `afterHandle` hooks receive. */
export interface AfterHandle {
  event: unknown;
  ctx: WebhookHandleContext;
  durationMs: number;
  error?: unknown;
}

/** The hooks of the native, by name. */
export interface WebhookHooks {
  beforeDeliver: FeatureHook<BeforeDeliver, undefined>;
  afterDeliver: FeatureHook<AfterDeliver, undefined>;
  onDisabled: FeatureHook<OnDisabled, undefined>;
  beforeHandle: FeatureHook<BeforeHandle, undefined>;
  afterHandle: FeatureHook<AfterHandle, undefined>;
}

/** What a `sender` sends: one signed attempt's subscription, delivery, body text and headers. */
export interface WebhookSendInput {
  subscription: StoredSubscription;
  delivery: WebhookDelivery;
  /** The exact body text. */
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

/**
 * Replaces how attempts are signed and sent (the `sender` option), like a hosted delivery service; resolving any
 * status records it, rejecting records a failed attempt with the error's message.
 */
export interface WebhookSender {
  send(input: WebhookSendInput): Promise<{ status: number; body?: string; durationMs: number }>;
}
