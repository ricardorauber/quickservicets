import type { EntityModel, FieldModel, NestedFieldModel } from "../public.ts";

/** The states of a queue message. */
export const QUEUE_MESSAGE_STATUSES = ["waiting", "active", "completed", "dead"] as const;
export type QueueMessageStatus = (typeof QUEUE_MESSAGE_STATUSES)[number];

/** One stored queue message, as `repos.queueMessages` returns it. */
export type QueueMessage = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  queue: string;
  payload: unknown;
  status: QueueMessageStatus;
  priority: number;
  runAt: Date;
  /** The attempts started so far: 0 before the first run. */
  attempt: number;
  maxAttempts: number;
  dedupeKey?: string | null;
  /** `<queue>:<dedupeKey>` while the message deduplicates its key. */
  dedupeSlot?: string | null;
  lockedUntil?: Date | null;
  /** `<hostname>:<pid>` of the process running it. */
  worker?: string | null;
  lastError?: { message: string; stack?: string | null } | null;
  result?: unknown;
  enqueuedAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  requestId?: string | null;
  /** The ids of the user and tenant of the request that added it. */
  actor?: { user?: string | null; tenant?: string | null } | null;
};

const column = (field: NestedFieldModel): FieldModel => ({ ...field, storage: "column" });
const json = (field: NestedFieldModel): FieldModel => ({ ...field, storage: "json" });

/** The system entity of queue messages, part of the model while the `queues` native is enabled. */
export function queueMessageEntity(): EntityModel {
  const fields: FieldModel[] = [
    column({ name: "queue", type: "string", optional: false }),
    json({ name: "payload", type: "json", optional: false }),
    column({ name: "status", type: "enum", values: [...QUEUE_MESSAGE_STATUSES], optional: false }),
    column({ name: "priority", type: "number", optional: false, default: 0 }),
    column({ name: "runAt", type: "date", optional: false }),
    column({ name: "attempt", type: "number", optional: false, min: 0 }),
    column({ name: "maxAttempts", type: "number", optional: false, min: 1 }),
    column({ name: "dedupeKey", type: "string", optional: true }),
    // `<queue>:<dedupeKey>` while the message deduplicates its key; unique, so concurrent adds insert one message.
    { name: "dedupeSlot", type: "string", optional: true, unique: true, storage: "column" } as FieldModel,
    column({ name: "lockedUntil", type: "date", optional: true }),
    column({ name: "worker", type: "string", optional: true }),
    json({
      name: "lastError",
      type: "object",
      optional: true,
      fields: [
        { name: "message", type: "string", optional: false },
        { name: "stack", type: "string", optional: true },
      ],
    }),
    json({ name: "result", type: "json", optional: true }),
    column({ name: "enqueuedAt", type: "date", optional: false }),
    column({ name: "startedAt", type: "date", optional: true }),
    column({ name: "finishedAt", type: "date", optional: true }),
    column({ name: "requestId", type: "string", optional: true }),
    json({
      name: "actor",
      type: "object",
      optional: true,
      fields: [
        { name: "user", type: "string", optional: true },
        { name: "tenant", type: "string", optional: true },
      ],
    }),
  ];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "QueueMessage",
    entityName: "QueueMessage",
    schema: null,
    name: "queue-messages",
    repoKey: "queueMessages",
    tableName: "queue_messages",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["queue", "status", "priority", "runAt"] }],
    system: true,
  };
}
