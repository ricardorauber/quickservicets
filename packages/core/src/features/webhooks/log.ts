import { HttpError, parseDuration, safeLog, systemTarget, type Condition, type DatabaseAdapter, type EntityModel, type Logger } from "../public.ts";
import { WEBHOOK_DELIVERY_STATUSES, type WebhookDelivery } from "./deliveries.ts";
import { webhookClock } from "./state.ts";

/** Deliveries deleted per batch by the cleanup. */
export const CLEANUP_BATCH = 1000;

/** How often every worker that runs scheduled work deletes old deliveries and receipts. */
export const CLEANUP_INTERVAL = 3_600_000;

/** The fields a listed delivery shows. */
const LIST_FIELDS = ["id", "event", "type", "status", "attempt", "nextAttemptAt", "lastStatus", "lastError", "durationMs", "deliveredAt", "createdAt"] as const;

/** A delivery as the list shows it, without its body and response. */
export type DeliverySummary = Pick<WebhookDelivery, (typeof LIST_FIELDS)[number]>;

/** A page of deliveries. */
export interface DeliveryPage {
  data: DeliverySummary[];
  total: number;
  limit: number;
  offset: number;
}

/** What a list of deliveries may filter by. */
export interface DeliveryListOptions {
  status?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

const condition = (field: string, op: "eq" | "lt" | "in", value: unknown): Condition => ({ field, op, value }) as Condition;

/** A delivery as the list shows it. */
export const summaryOf = (delivery: WebhookDelivery): DeliverySummary => Object.fromEntries(LIST_FIELDS.map((field) => [field, delivery[field] ?? null])) as DeliverySummary;

/** A delivery as the detail shows it: the summary with the body sent and the response kept. */
export const detailOf = (delivery: WebhookDelivery) => ({ ...summaryOf(delivery), payload: delivery.payload, lastResponse: delivery.lastResponse ?? null });

/** The deliveries of the project's database: listing, resending and cleaning up. */
export function deliveryLog(options: { adapter: DatabaseAdapter; model: EntityModel; logger: Logger; now?: () => number }) {
  const now = options.now ?? (() => webhookClock.now());
  const db = () => systemTarget(options.adapter, options.model).adapter;
  return {
    /** The deliveries of a subscription, newest first. */
    async list(subscription: string, query: DeliveryListOptions = {}): Promise<DeliveryPage> {
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), 100);
      const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
      if (query.status !== undefined && !(WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(query.status)) {
        throw new HttpError(400, "Invalid query", { details: [{ field: "status", message: `Must be one of ${WEBHOOK_DELIVERY_STATUSES.join(", ")}` }] });
      }
      const where = [condition("subscription", "eq", subscription), ...(query.status ? [condition("status", "eq", query.status)] : []), ...(query.type ? [condition("type", "eq", query.type)] : [])];
      const found = await db().findMany(options.model, { where, sort: [{ field: "createdAt", direction: "desc" }, { field: "id", direction: "desc" }], limit, offset });
      return { data: (found.data as unknown as WebhookDelivery[]).map(summaryOf), total: found.total, limit, offset };
    },
    /** One delivery, or null. */
    async get(id: string): Promise<WebhookDelivery | null> {
      return (await db().findById(options.model, id)) as unknown as WebhookDelivery | null;
    },
    /** Puts a finished delivery back to `pending` with attempt 0; the caller enqueues it. */
    async reset(delivery: WebhookDelivery): Promise<WebhookDelivery> {
      if (delivery.status === "pending" || delivery.status === "delivering") throw new HttpError(409, "Delivery is already scheduled", { code: "CONFLICT" });
      const reset = await db().updateById(options.model, delivery.id, { status: "pending", attempt: 0, nextAttemptAt: new Date(now()), updatedAt: new Date(now()) }, [condition("status", "eq", delivery.status)]);
      if (!reset) throw new HttpError(409, "Delivery is already scheduled", { code: "CONFLICT" });
      return reset as unknown as WebhookDelivery;
    },
    /** The ids of a subscription's failed deliveries. */
    async failedOf(subscription: string): Promise<string[]> {
      const ids: string[] = [];
      for (let offset = 0; ; offset += CLEANUP_BATCH) {
        const { data } = await db().findMany(options.model, { where: [condition("subscription", "eq", subscription), condition("status", "eq", "failed")], sort: [{ field: "id", direction: "asc" }], limit: CLEANUP_BATCH, offset, withTotal: false });
        ids.push(...data.map((row) => row.id));
        if (data.length < CLEANUP_BATCH) return ids;
      }
    },
    /** The number of deliveries per status of a subscription created since `since`. */
    async counts(subscription: string, since: Date): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};
      for (const status of WEBHOOK_DELIVERY_STATUSES) {
        counts[status] = await db().count(options.model, [condition("subscription", "eq", subscription), condition("status", "eq", status), { field: "createdAt", op: "gte", value: since } as Condition]);
      }
      return counts;
    },
    /** Deletes finished deliveries older than `retention`, in batches; pending and delivering ones are kept. */
    async cleanup(retention: string): Promise<number> {
      const before = new Date(now() - (parseDuration(retention) ?? 30 * 86_400_000));
      let deleted = 0;
      for (;;) {
        const { data } = await db().findMany(options.model, {
          where: [condition("status", "in", ["succeeded", "failed"]), condition("createdAt", "lt", before)],
          sort: [{ field: "id", direction: "asc" }],
          limit: CLEANUP_BATCH,
          offset: 0,
          withTotal: false,
        });
        for (const row of data) if (await db().deleteById(options.model, row.id)) deleted++;
        if (data.length < CLEANUP_BATCH) break;
      }
      safeLog(options.logger, "info", { timestamp: new Date(now()).toISOString(), message: "webhooks.cleanup", count: deleted });
      return deleted;
    },
  };
}

export type DeliveryLog = ReturnType<typeof deliveryLog>;
