import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HttpError, parseDuration, safeLog, systemTarget, UniqueViolationError, type Condition, type DatabaseAdapter, type EntityModel, type FieldModel, type Logger, type StoredRecord } from "../public.ts";
import { CLEANUP_BATCH } from "./log.ts";
import { webhookClock } from "./state.ts";

/** How long a `processing` receipt keeps a repeated delivery away before another request may take it over. */
export const RECEIPT_LOCK_MS = 60_000;

/** The statuses of a receipt. */
export const RECEIPT_STATUSES = ["processing", "processed", "failed"] as const;

/** One incoming delivery, as the native keeps it to process it once. */
export interface WebhookReceipt {
  id: string;
  /** The route pattern, like `/stripe`. */
  endpoint: string;
  deliveryId: string;
  status: (typeof RECEIPT_STATUSES)[number];
  receivedAt: Date;
  lockedUntil?: Date | null;
  /** The request's tenant, empty without one, so the unique index also covers tenant-less deliveries. */
  tenant?: string | null;
}

/** The system entity of incoming delivery receipts: read-only, no routes. */
export function webhookReceiptEntity(): EntityModel {
  const fields = [
    { name: "endpoint", type: "string", optional: false, storage: "column" },
    { name: "deliveryId", type: "string", optional: false, storage: "column" },
    { name: "status", type: "enum", values: [...RECEIPT_STATUSES], optional: false, storage: "column" },
    { name: "receivedAt", type: "date", optional: false, storage: "column" },
    { name: "lockedUntil", type: "date", optional: true, storage: "column" },
    { name: "tenant", type: "string", optional: true, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "WebhookReceipt",
    entityName: "WebhookReceipt",
    schema: null,
    name: "webhook-receipts",
    repoKey: "webhookReceipts",
    tableName: "webhook_receipts",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    system: true,
    tenancy: "shared",
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["endpoint", "deliveryId", "tenant"], unique: true }, { fields: ["receivedAt"] }],
  };
}

/** Whether a folder of endpoint files holds a `webhook.ts` file, at any depth. */
export function hasWebhookFiles(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const full = join(dir, entry);
    if (entry === "webhook.ts") return true;
    try {
      return statSync(full).isDirectory() && hasWebhookFiles(full);
    } catch {
      return false;
    }
  });
}

const condition = (field: string, op: "eq" | "lt", value: unknown): Condition => ({ field, op, value }) as Condition;

/** What claiming a delivery found: a receipt to process, or a duplicate to answer. */
export type ReceiptClaim = { kind: "claimed"; receipt: WebhookReceipt } | { kind: "processed" } | { kind: "busy" };

/** The receipts of incoming deliveries in the project's database. */
export function receiptStore(options: { adapter: DatabaseAdapter; model: EntityModel; logger: Logger; now?: () => number }) {
  const now = options.now ?? (() => webhookClock.now());
  const db = () => systemTarget(options.adapter, options.model).adapter;
  return {
    /**
     * Inserts a `processing` receipt for the delivery, or finds the existing one: `processed` is a duplicate, a live
     * `processing` one is busy, and a `failed` one or one whose lock passed is taken over by a conditional update.
     */
    async claim(input: { endpoint: string; deliveryId: string; tenant?: string }): Promise<ReceiptClaim> {
      const tenant = input.tenant ?? "";
      for (let round = 0; round < 3; round++) {
        const at = now();
        const row: StoredRecord = { id: Bun.randomUUIDv7(), createdAt: new Date(at), updatedAt: new Date(at), endpoint: input.endpoint, deliveryId: input.deliveryId, status: "processing", receivedAt: new Date(at), lockedUntil: new Date(at + RECEIPT_LOCK_MS), tenant };
        try {
          return { kind: "claimed", receipt: (await db().insert(options.model, row)) as unknown as WebhookReceipt };
        } catch (error) {
          if (!(error instanceof UniqueViolationError)) throw error;
        }
        const existing = (await db().findOne(options.model, [condition("endpoint", "eq", input.endpoint), condition("deliveryId", "eq", input.deliveryId), condition("tenant", "eq", tenant)])) as unknown as WebhookReceipt | null;
        if (!existing) continue;
        if (existing.status === "processed") return { kind: "processed" };
        const locked = existing.lockedUntil ? new Date(existing.lockedUntil).getTime() : 0;
        if (existing.status === "processing" && locked > at) return { kind: "busy" };
        const guard = [condition("status", "eq", existing.status), condition("updatedAt", "eq", (existing as unknown as { updatedAt: Date }).updatedAt)];
        const taken = await db().updateById(options.model, existing.id, { status: "processing", lockedUntil: new Date(at + RECEIPT_LOCK_MS), updatedAt: new Date(at) }, guard);
        return taken ? { kind: "claimed", receipt: taken as unknown as WebhookReceipt } : { kind: "busy" };
      }
      return { kind: "busy" };
    },
    /** Whether the delivery was processed before. */
    async isProcessed(input: { endpoint: string; deliveryId: string; tenant?: string }): Promise<boolean> {
      const existing = await db().findOne(options.model, [condition("endpoint", "eq", input.endpoint), condition("deliveryId", "eq", input.deliveryId), condition("tenant", "eq", input.tenant ?? "")]);
      return existing?.status === "processed";
    },
    /** Marks a receipt `processed` or `failed`. */
    async finish(id: string, status: "processed" | "failed"): Promise<void> {
      await db().updateById(options.model, id, { status, lockedUntil: null, updatedAt: new Date(now()) });
    },
    /** Deletes receipts received longer than `retention` ago, in batches. */
    async cleanup(retention: string): Promise<number> {
      const before = new Date(now() - (parseDuration(retention) ?? 7 * 86_400_000));
      let deleted = 0;
      for (;;) {
        const { data } = await db().findMany(options.model, { where: [condition("receivedAt", "lt", before)], sort: [{ field: "id", direction: "asc" }], limit: CLEANUP_BATCH, offset: 0, withTotal: false });
        for (const row of data) if (await db().deleteById(options.model, row.id)) deleted++;
        if (data.length < CLEANUP_BATCH) break;
      }
      safeLog(options.logger, "info", { timestamp: new Date(now()).toISOString(), message: "webhooks.receipts.cleanup", count: deleted });
      return deleted;
    },
  };
}

export type ReceiptStore = ReturnType<typeof receiptStore>;

/** The answer to a delivery another request is processing. */
export const deliveryBusy = () => new HttpError(409, "Webhook delivery is being processed", { code: "CONFLICT", headers: { "retry-after": "5" } });
