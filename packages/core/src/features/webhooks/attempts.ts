import { HttpError, systemTarget, type DatabaseAdapter, type EntityModel, type Logger } from "../public.ts";
import type { WebhookDelivery } from "./deliveries.ts";
import { attemptHeaders, logAttempt, sendAttempt, type AttemptOutcome } from "./send.ts";
import type { StoredSubscription, SubscriptionStore } from "./subscriptions.ts";

/** The reason a subscription is disabled when its receiver answers 410. */
export const GONE_REASON = "Receiver answered 410 Gone";

/** How many pings one subscription may send per minute. */
export const PING_LIMIT = 10;

/** What a ping answers. */
export interface PingResult {
  status: number;
  ok: boolean;
  durationMs: number;
}

/** A failed attempt, handed to the failure rule. */
export interface FailedAttempt {
  delivery: WebhookDelivery;
  subscription: StoredSubscription;
  outcome: AttemptOutcome;
}

/** Runs `fn` with at most `limit` runs at once per key. */
export function keyedLimiter(limit: number) {
  const states = new Map<string, { running: number; waiting: (() => void)[] }>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    let state = states.get(key);
    if (!state) states.set(key, (state = { running: 0, waiting: [] }));
    const current = state;
    if (current.running >= limit) await new Promise<void>((resolve) => current.waiting.push(resolve));
    else current.running++;
    try {
      return await fn();
    } finally {
      const next = current.waiting.shift();
      if (next) next();
      else {
        current.running--;
        if (current.running === 0) states.delete(key);
      }
    }
  };
}

/** What the deliverer needs from the running native. */
export interface DelivererOptions {
  adapter: DatabaseAdapter;
  model: EntityModel;
  store: SubscriptionStore;
  delivery: { timeout: string; responseBodyLimit: string | number; concurrency: number };
  logger: Logger;
  /** What happens to a delivery whose attempt failed; marks it `failed` by default. */
  failed?: (attempt: FailedAttempt) => Promise<void>;
  now?: () => number;
}

/** Sends deliveries and pings: one attempt each, signed, through the HTTP client with SSRF protection. */
export function deliverer(options: DelivererOptions) {
  const now = options.now ?? Date.now;
  const limited = keyedLimiter(options.delivery.concurrency);
  const db = () => systemTarget(options.adapter, options.model).adapter;
  const update = (id: string, changes: Record<string, unknown>) => db().updateById(options.model, id, { ...changes, updatedAt: new Date(now()) });
  const pings = new Map<string, number[]>();
  const attempt = (subscription: StoredSubscription, eventId: string, payload: unknown, signal?: AbortSignal) => {
    const body = JSON.stringify(payload);
    const headers = attemptHeaders({ subscription, eventId, body, at: now() });
    return sendAttempt({ url: subscription.url, body, headers, timeout: options.delivery.timeout, responseBodyLimit: options.delivery.responseBodyLimit, ...(signal ? { signal } : {}) });
  };
  const failed =
    options.failed ??
    (async ({ delivery }: FailedAttempt) => {
      await update(delivery.id, { status: "failed", nextAttemptAt: null });
    });
  return {
    /** Runs one attempt of a delivery: a pending one, or one a stopped worker left delivering (the same attempt again). */
    async deliver(id: string, context: { signal?: AbortSignal } = {}): Promise<void> {
      const delivery = (await db().findById(options.model, id)) as unknown as WebhookDelivery | null;
      if (!delivery || (delivery.status !== "pending" && delivery.status !== "delivering")) return;
      const subscription = await options.store.stored(String(delivery.subscription));
      if (!subscription) return;
      if (!subscription.enabled) {
        await update(delivery.id, { status: "failed", lastError: "Subscription disabled", nextAttemptAt: null });
        return;
      }
      const number = delivery.status === "delivering" ? Math.max(delivery.attempt, 1) : delivery.attempt + 1;
      await update(delivery.id, { status: "delivering", attempt: number });
      const outcome = await limited(subscription.id, () => attempt(subscription, delivery.event, delivery.payload, context.signal));
      logAttempt(options.logger, { subscription: subscription.id, delivery: delivery.id, type: delivery.type, attempt: number, outcome });
      const recorded = { lastStatus: outcome.status, durationMs: outcome.durationMs, lastResponse: outcome.response ?? null };
      if (outcome.ok) {
        await update(delivery.id, { ...recorded, status: "succeeded", deliveredAt: new Date(now()), lastError: null, nextAttemptAt: null });
        if (subscription.failingSince) await options.store.patch(subscription.id, { failingSince: null });
        return;
      }
      const stored = (await update(delivery.id, { ...recorded, lastError: outcome.error ?? null })) as unknown as WebhookDelivery | null;
      let current = subscription;
      if (outcome.status === 410) current = (await options.store.patch(subscription.id, { enabled: false, disabledReason: GONE_REASON })) ?? { ...subscription, enabled: false, disabledReason: GONE_REASON };
      await failed({ delivery: stored ?? { ...delivery, attempt: number }, subscription: current, outcome });
    },
    /** Sends a signed `webhook.ping` at once, without a delivery; at most 10 per minute per subscription. */
    async ping(subscription: StoredSubscription): Promise<PingResult> {
      const at = now();
      const recent = (pings.get(subscription.id) ?? []).filter((time) => at - time < 60_000);
      if (recent.length >= PING_LIMIT) throw new HttpError(429, "Too many requests", { headers: { "retry-after": String(Math.ceil((recent[0]! + 60_000 - at) / 1000)) } });
      recent.push(at);
      pings.set(subscription.id, recent);
      const id = Bun.randomUUIDv7();
      const payload = { id, type: "webhook.ping", timestamp: new Date(at).toISOString(), data: { subscriptionId: subscription.id } };
      const outcome = await limited(subscription.id, () => attempt(subscription, id, payload));
      logAttempt(options.logger, { subscription: subscription.id, type: "webhook.ping", attempt: 1, outcome });
      return { status: outcome.status, ok: outcome.ok, durationMs: outcome.durationMs };
    },
  };
}

export type Deliverer = ReturnType<typeof deliverer>;
