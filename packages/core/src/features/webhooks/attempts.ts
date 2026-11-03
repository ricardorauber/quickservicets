import { HttpError, runAfterHooks, runBeforeHooks, systemTarget, type FeatureHook, type DatabaseAdapter, type EntityModel, type Logger } from "../public.ts";
import type { WebhookDelivery } from "./deliveries.ts";
import { attemptHeaders, logAttempt, sendAttempt, type AttemptOutcome } from "./send.ts";
import { publicSubscription, type StoredSubscription, type SubscriptionStore } from "./subscriptions.ts";
import type { AfterDeliver, BeforeDeliver, WebhookSender } from "./api.ts";
import { webhookClock } from "./state.ts";

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
  /** Runs after a successful attempt, with the delivery and the status. */
  succeeded?: (delivery: WebhookDelivery, status: number) => Promise<void>;
  /** Disables a subscription; a plain update by default. */
  disable?: (subscription: StoredSubscription, reason: string) => Promise<StoredSubscription>;
  /** More headers of each attempt: a record, or a function of the subscription, the event and the tenant. */
  headers?: unknown;
  /** Replaces signing and sending. */
  sender?: WebhookSender;
  beforeDeliver?: readonly FeatureHook<BeforeDeliver, undefined>[];
  afterDeliver?: readonly FeatureHook<AfterDeliver, undefined>[];
  now?: () => number;
}

/** A delivery's attempt that a `delivery.headers` function or a `beforeDeliver` hook stopped. */
class AttemptStopped extends Error {
  constructor(
    message: string,
    readonly final: boolean,
  ) {
    super(message);
  }
}

/** Sends deliveries and pings: one attempt each, signed, through the HTTP client with SSRF protection. */
export function deliverer(options: DelivererOptions) {
  const now = options.now ?? (() => webhookClock.now());
  const limited = keyedLimiter(options.delivery.concurrency);
  const db = () => systemTarget(options.adapter, options.model).adapter;
  const update = (id: string, changes: Record<string, unknown>) => db().updateById(options.model, id, { ...changes, updatedAt: new Date(now()) });
  const pings = new Map<string, number[]>();
  /** The headers of `delivery.headers` for one attempt; a throwing function fails the attempt. */
  const extraHeaders = async (subscription: StoredSubscription, event: unknown): Promise<Record<string, string>> => {
    const value = options.headers;
    if (typeof value !== "function") return (value as Record<string, string> | undefined) ?? {};
    try {
      return ((await value({ req: undefined, user: undefined, subscription: publicSubscription(subscription), event, tenant: subscription.tenant ?? undefined })) as Record<string, string> | undefined) ?? {};
    } catch (error) {
      throw new AttemptStopped(`delivery.headers failed: ${(error as Error)?.message ?? String(error)}`, false);
    }
  };
  /** Signs and sends one attempt: the hooks may change the body and headers first, a `sender` may send it instead. */
  const attempt = async (subscription: StoredSubscription, eventId: string, payload: unknown, signal?: AbortSignal, delivery?: WebhookDelivery): Promise<AttemptOutcome> => {
    const started = performance.now();
    try {
      let body = payload;
      let extra = await extraHeaders(subscription, payload);
      if (delivery && options.beforeDeliver && options.beforeDeliver.length > 0) {
        let step: BeforeDeliver;
        try {
          step = await runBeforeHooks(options.beforeDeliver, { subscription: publicSubscription(subscription), delivery, body, headers: extra }, undefined);
        } catch (error) {
          throw new AttemptStopped(`Canceled by beforeDeliver: ${(error as Error)?.message ?? String(error)}`, true);
        }
        body = step.body;
        extra = step.headers;
      }
      const text = JSON.stringify(body);
      const headers = attemptHeaders({ subscription, eventId, body: text, at: now(), extra });
      if (options.sender && delivery) {
        const { "webhook-signature": _signature, ...unsigned } = headers;
        try {
          const sent = await options.sender.send({ subscription, delivery, body: text, headers: unsigned, signal: signal ?? new AbortController().signal });
          const ok = sent.status >= 200 && sent.status < 300;
          return { ok, status: sent.status, durationMs: sent.durationMs, ...(sent.body !== undefined ? { response: sent.body } : {}), ...(ok ? {} : { error: `${sent.status}` }) };
        } catch (error) {
          return { ok: false, status: 0, durationMs: Math.round((performance.now() - started) * 1000) / 1000, error: (error as Error)?.message ?? String(error) };
        }
      }
      return await sendAttempt({ url: subscription.url, body: text, headers, timeout: options.delivery.timeout, responseBodyLimit: options.delivery.responseBodyLimit, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (!(error instanceof AttemptStopped)) throw error;
      return { ok: false, status: 0, durationMs: Math.round((performance.now() - started) * 1000) / 1000, error: error.message, ...(error.final ? { final: true } : {}) };
    }
  };
  const disable =
    options.disable ??
    (async (subscription: StoredSubscription, reason: string) => (await options.store.patch(subscription.id, { enabled: false, disabledReason: reason })) ?? { ...subscription, enabled: false, disabledReason: reason });
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
      const outcome = await limited(subscription.id, () => attempt(subscription, delivery.event, delivery.payload, context.signal, { ...delivery, attempt: number }));
      // A worker shutting down gives the message back: the delivery stays delivering and runs as the same attempt.
      if (context.signal?.aborted && (context.signal.reason as { name?: unknown } | undefined)?.name === "AbortError") return new Promise<never>(() => {});
      logAttempt(options.logger, { subscription: subscription.id, delivery: delivery.id, type: delivery.type, attempt: number, outcome });
      if (options.afterDeliver && options.afterDeliver.length > 0) {
        await runAfterHooks(options.afterDeliver, { subscription: publicSubscription(subscription), delivery: { ...delivery, attempt: number }, status: outcome.status, ok: outcome.ok, durationMs: outcome.durationMs }, undefined);
      }
      const recorded = { lastStatus: outcome.status, durationMs: outcome.durationMs, lastResponse: outcome.response ?? null };
      if (outcome.ok) {
        const done = (await update(delivery.id, { ...recorded, status: "succeeded", deliveredAt: new Date(now()), lastError: null, nextAttemptAt: null })) as unknown as WebhookDelivery | null;
        if (subscription.failingSince) await options.store.patch(subscription.id, { failingSince: null });
        await options.succeeded?.(done ?? { ...delivery, attempt: number }, outcome.status);
        return;
      }
      const stored = (await update(delivery.id, { ...recorded, lastError: outcome.error ?? null })) as unknown as WebhookDelivery | null;
      // A beforeDeliver hook that threw ends the delivery without retries.
      if (outcome.final) {
        await update(delivery.id, { status: "failed", nextAttemptAt: null });
        return;
      }
      let current = subscription;
      if (outcome.status === 410) current = await disable(subscription, GONE_REASON);
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
