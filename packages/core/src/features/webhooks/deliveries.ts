import type { AnyEvent, EntityModel, FieldModel, WriteEvent } from "../public.ts";
import type { EntityDelivery } from "./deliverable.ts";

/** The statuses of a delivery. */
export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivering", "succeeded", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** The largest body a delivery may carry. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** One delivery of an event to a subscription, as the native stores it. */
export interface WebhookDelivery {
  id: string;
  subscription: string;
  /** The event's id, sent as `webhook-id` on every attempt. */
  event: string;
  type: string;
  /** The JSON body, built once per event. */
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempt: number;
  nextAttemptAt?: Date | null;
  lastStatus?: number | null;
  lastError?: string | null;
  lastResponse?: string | null;
  durationMs?: number | null;
  deliveredAt?: Date | null;
  tenant?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The system entity of deliveries: read-only for projects, no routes. */
export function webhookDeliveryEntity(): EntityModel {
  const fields = [
    { name: "subscription", type: "ref", target: "WebhookSubscription", onDelete: "cascade", optional: false, storage: "column" },
    { name: "event", type: "string", optional: false, storage: "column" },
    { name: "type", type: "string", optional: false, storage: "column" },
    { name: "payload", type: "json", optional: false, storage: "json" },
    { name: "status", type: "enum", values: [...WEBHOOK_DELIVERY_STATUSES], optional: false, storage: "column" },
    { name: "attempt", type: "number", integer: true, optional: false, storage: "column" },
    { name: "nextAttemptAt", type: "date", optional: true, storage: "column" },
    { name: "lastStatus", type: "number", integer: true, optional: true, storage: "column" },
    { name: "lastError", type: "string", optional: true, storage: "column" },
    { name: "lastResponse", type: "string", optional: true, storage: "column" },
    { name: "durationMs", type: "number", optional: true, storage: "column" },
    { name: "deliveredAt", type: "date", optional: true, storage: "column" },
    { name: "tenant", type: "string", optional: true, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "WebhookDelivery",
    entityName: "WebhookDelivery",
    schema: null,
    name: "webhook-deliveries",
    repoKey: "webhookDeliveries",
    tableName: "webhook_deliveries",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    system: true,
    tenancy: "shared",
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["subscription", "event"], unique: true }, { fields: ["subscription", "status"] }],
  };
}

/** The fields a delivered record leaves out: `@hidden` and `@sensitive` ones, or every field but `fields` and `id`. */
export function recordProjector(entry: EntityDelivery | undefined): (record: unknown) => unknown {
  if (!entry) return (record) => record;
  const concealed = new Set(entry.entity.fields.filter((field) => field.hidden === true || field.tags?.sensitive?.on === true).map((field) => field.name));
  const kept = entry.fields ? new Set(["id", ...entry.fields]) : undefined;
  return (record) => {
    if (record === null || typeof record !== "object") return record;
    const entries = Object.entries(record as Record<string, unknown>);
    return Object.fromEntries(kept ? entries.filter(([name]) => kept.has(name)) : entries.filter(([name]) => !concealed.has(name)));
  };
}

/** The body every delivery of an event carries: its id, type, time and data. */
export function bodyOf(event: AnyEvent, entry: EntityDelivery | undefined): Record<string, unknown> {
  const at = event.at instanceof Date ? event.at : new Date(event.at);
  const write = (event as WriteEvent).operation !== undefined && (event as WriteEvent).entity !== undefined ? (event as WriteEvent) : undefined;
  let data: unknown;
  if (write) {
    const project = recordProjector(entry);
    const concealed = entry ? recordProjector(entry)(Object.fromEntries(write.changed.map((name) => [name, true]))) as Record<string, unknown> : undefined;
    data = {
      entity: write.entity,
      operation: write.operation,
      recordId: write.recordId,
      record: project(write.operation === "deleted" ? write.before : write.after),
      changed: concealed ? write.changed.filter((name) => Object.hasOwn(concealed, name)) : write.changed,
      ...(write.cause !== "write" ? { cause: write.cause } : {}),
    };
  } else data = (event as { payload?: unknown }).payload;
  return { id: event.id, type: event.type, timestamp: at.toISOString(), data };
}
