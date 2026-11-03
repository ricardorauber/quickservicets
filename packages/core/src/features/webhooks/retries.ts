import { parseDuration, queues, safeLog, systemTarget, type Condition, type DatabaseAdapter, type EntityModel, type Logger } from "../public.ts";
import type { FailedAttempt } from "./attempts.ts";
import type { WebhookDelivery } from "./deliveries.ts";
import { DELIVER_QUEUE } from "./matching.ts";
import type { StoredSubscription, SubscriptionStore } from "./subscriptions.ts";
import { webhookClock } from "./state.ts";

/** The longest entry of `delivery.retrySchedule`. */
export const MAX_RETRY_DELAY_MS = 7 * 86_400_000;

/** The message of an invalid `delivery.retrySchedule`. */
export const RETRY_SCHEDULE_PROBLEM = "Invalid webhooks.delivery.retrySchedule: expected 1 to 20 durations of at most 7d";

/** Whether a retry schedule has 1 to 20 durations of at most 7 days. */
export function validSchedule(schedule: readonly string[]): boolean {
  if (schedule.length < 1 || schedule.length > 20) return false;
  return schedule.every((entry) => {
    const ms = parseDuration(entry);
    return ms !== undefined && ms >= 0 && ms <= MAX_RETRY_DELAY_MS;
  });
}

/** The delay before the retry after attempt `attempt` (1-based), with up to ±10% jitter; null after the last one. */
export function retryDelay(schedule: readonly string[], attempt: number, random: () => number = Math.random): number | null {
  if (attempt < 1 || attempt > schedule.length) return null;
  const base = parseDuration(schedule[attempt - 1]!) ?? 0;
  return Math.max(0, Math.round(base * (1 + (random() * 2 - 1) * 0.1)));
}

/** The payload of `webhook.delivery.succeeded` and `webhook.delivery.failed`. */
export interface WebhookDeliveryEvent {
  subscriptionId: string;
  deliveryId: string;
  eventId: string;
  type: string;
  attempt: number;
  /** The receiver's last status, 0 without an answer. */
  status: number;
}

/** The payload of `webhook.subscription.disabled`. */
export interface WebhookSubscriptionDisabledEvent {
  subscriptionId: string;
  reason: string;
  tenant?: string;
}

/** What the retry rule needs from the running native. */
export interface RetryRuleOptions {
  adapter: DatabaseAdapter;
  model: EntityModel;
  store: SubscriptionStore;
  schedule: readonly string[];
  disableAfter: string;
  logger: Logger;
  emit: (type: string, payload: object) => Promise<unknown>;
  /** Runs after a subscription is disabled, with it and the reason. */
  disabled?: (subscription: StoredSubscription, reason: string) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const condition = (field: string, op: "eq", value: unknown): Condition => ({ field, op, value }) as Condition;

/**
 * What happens after each attempt: a failed one is retried on the schedule through a new `webhooks/deliver` message,
 * ends `failed` after the last one, and disables a subscription failing for longer than `disableAfter`; outcomes become
 * events.
 */
export function retryRule(options: RetryRuleOptions) {
  const now = options.now ?? (() => webhookClock.now());
  const disableAfterMs = parseDuration(options.disableAfter) ?? 5 * 86_400_000;
  const db = () => systemTarget(options.adapter, options.model).adapter;
  const update = (id: string, changes: Record<string, unknown>) => db().updateById(options.model, id, { ...changes, updatedAt: new Date(now()) });
  const emit = async (type: string, payload: object) => {
    try {
      await options.emit(type, payload);
    } catch (error) {
      safeLog(options.logger, "error", { timestamp: new Date().toISOString(), message: "webhook.event.failed", type, error: { message: (error as Error)?.message ?? String(error) } });
    }
  };
  const eventOf = (delivery: WebhookDelivery, status: number): WebhookDeliveryEvent => ({
    subscriptionId: String(delivery.subscription),
    deliveryId: delivery.id,
    eventId: delivery.event,
    type: delivery.type,
    attempt: delivery.attempt,
    status,
  });
  const rule = {
    /** Disables a subscription, failing its pending deliveries, and tells the owner. */
    async disable(subscription: StoredSubscription, reason: string): Promise<StoredSubscription> {
      const disabled = (await options.store.patch(subscription.id, { enabled: false, disabledReason: reason })) ?? { ...subscription, enabled: false, disabledReason: reason };
      for (;;) {
        const { data } = await db().findMany(options.model, { where: [condition("subscription", "eq", subscription.id), condition("status", "eq", "pending")], sort: [{ field: "id", direction: "asc" }], limit: 1000, offset: 0, withTotal: false });
        for (const row of data) await update(row.id, { status: "failed", lastError: "Subscription disabled", nextAttemptAt: null });
        if (data.length < 1000) break;
      }
      safeLog(options.logger, "warn", { timestamp: new Date(now()).toISOString(), message: "webhook.subscription.disabled", subscription: subscription.id, ...(subscription.tenant ? { tenant: subscription.tenant } : {}), reason });
      await emit("webhook.subscription.disabled", { subscriptionId: subscription.id, reason, ...(subscription.tenant ? { tenant: subscription.tenant } : {}) } satisfies WebhookSubscriptionDisabledEvent);
      await options.disabled?.(disabled, reason);
      return disabled;
    },
    /** After a successful attempt. */
    async succeeded(delivery: WebhookDelivery, status: number): Promise<void> {
      await emit("webhook.delivery.succeeded", eventOf(delivery, status));
    },
    /** After a failed attempt: schedule the next one, or end the delivery. */
    async failed({ delivery, subscription, outcome }: FailedAttempt): Promise<void> {
      let current = subscription;
      if (current.enabled) {
        const since = current.failingSince ? new Date(current.failingSince).getTime() : undefined;
        if (since === undefined) current = (await options.store.patch(current.id, { failingSince: new Date(now()) })) ?? current;
        else if (now() - since > disableAfterMs) current = await rule.disable(current, `Failing for more than ${options.disableAfter}`);
      }
      const delay = current.enabled ? retryDelay(options.schedule, delivery.attempt, options.random) : null;
      if (delay !== null) {
        const runAt = new Date(now() + delay);
        await update(delivery.id, { status: "pending", nextAttemptAt: runAt });
        await queues.add(DELIVER_QUEUE as never, delivery.id as never, { runAt, dedupeKey: `${delivery.id}:${delivery.attempt}` });
        return;
      }
      await update(delivery.id, { status: "failed", nextAttemptAt: null });
      await emit("webhook.delivery.failed", eventOf(delivery, outcome.status));
    },
  };
  return rule;
}

export type RetryRule = ReturnType<typeof retryRule>;
