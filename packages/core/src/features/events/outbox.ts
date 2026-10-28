import { assertWritable, formatTraceparent, parseDuration, runInTransaction, scopedAdapter, systemTarget, type AnyEvent, type DatabaseAdapter, type EntityModel, type FieldModel, type StoredRecord } from "../public.ts";
import { compilePattern, type CompiledPattern } from "./patterns.ts";
import { deliveryRows } from "./delivery.ts";
import { sharedState } from "./state.ts";
import { eventTraces } from "./traces.ts";

/** One stored event of the outbox, as `readOutbox` returns it. */
export interface OutboxRecord {
  /** The event's id, a UUIDv7. */
  id: string;
  type: string;
  /** The event, with its dates as ISO strings except `at`. */
  event: AnyEvent;
  at: Date;
  requestId?: string;
}

/** The system entity of outbox rows. */
export function outboxEventEntity(): EntityModel {
  const fields: FieldModel[] = [
    { name: "type", type: "string", optional: false, storage: "column" },
    { name: "event", type: "json", optional: false, storage: "json" },
    { name: "at", type: "date", optional: false, storage: "column" },
    { name: "requestId", type: "string", optional: true, storage: "column" },
    // The traceparent of the span that wrote the event, while a tracer is set; deliveries link to it.
    { name: "trace", type: "string", optional: true, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "OutboxEvent",
    entityName: "OutboxEvent",
    schema: null,
    name: "outbox-events",
    repoKey: "outboxEvents",
    tableName: "outbox_events",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["at"] }, { fields: ["type", "at"] }],
    system: true,
  };
}

interface OutboxState {
  adapter: DatabaseAdapter;
  model: EntityModel;
  /** The delivery rows of durable consumers. */
  deliveryModel?: EntityModel;
  /** The patterns of `outbox.events`, then those other natives added. */
  patterns: { text: string; compiled: CompiledPattern }[];
  /** Whether each type is stored, decided once per type. */
  stored: Map<string, boolean>;
}

const shared = sharedState("outbox", () => ({ state: undefined as OutboxState | undefined, added: [] as string[] }));
/** Patterns other natives added, kept until the native stops. */
const added = shared.added;

/** Starts the outbox for a running service with the patterns of `outbox.events`. */
export function startOutbox(adapter: DatabaseAdapter, model: EntityModel, patterns: readonly string[], deliveryModel?: EntityModel): void {
  shared.state = {
    adapter,
    model,
    ...(deliveryModel ? { deliveryModel } : {}),
    patterns: [...patterns, ...added].map((text) => ({ text, compiled: compilePattern(text) })),
    stored: new Map(),
  };
}

/** Stops the outbox: nothing is stored until it starts again. */
export function stopOutbox(): void {
  shared.state = undefined;
  added.length = 0;
}

/** The effective patterns: `outbox.events`, then those other natives added. */
export function outboxPatterns(): string[] {
  const state = shared.state;
  return state ? state.patterns.map((pattern) => pattern.text) : [...added];
}

/**
 * Makes the outbox store the events matching `patterns` even when `outbox.events` does not list them; other natives
 * call it from their setup.
 */
export function addOutboxPatterns(patterns: readonly string[]): void {
  for (const text of patterns) {
    const compiled = compilePattern(text);
    if (added.includes(text)) continue;
    added.push(text);
    const state = shared.state;
    if (state && !state.patterns.some((pattern) => pattern.text === text)) {
      state.patterns.push({ text, compiled });
      state.stored.clear();
    }
  }
}

/** Whether the outbox stores events of `type`. */
export function storesType(type: string): boolean {
  const state = shared.state;
  if (!state) return false;
  let stored = state.stored.get(type);
  if (stored === undefined) {
    stored = state.patterns.some((pattern) => pattern.compiled(type));
    state.stored.set(type, stored);
  }
  return stored;
}

/** Whether the outbox is running. */
export const outboxRunning = () => shared.state !== undefined;

/** The adapter (the current database scope's) and model of the running outbox; throws when it is off. */
export function outboxStore(): { adapter: DatabaseAdapter; model: EntityModel; deliveryModel?: EntityModel } {
  const state = shared.state;
  if (!state) throw new Error("The outbox is not enabled; set events: { outbox: true } in quickservicets.config.ts");
  return { adapter: scopedAdapter(state.adapter), model: state.model, ...(state.deliveryModel ? { deliveryModel: state.deliveryModel } : {}) };
}

/** Stores an event as an outbox row, with one pending delivery row per matching consumer, in the caller's transaction. */
export async function insertOutboxRow(event: AnyEvent): Promise<void> {
  const state = shared.state;
  if (!state) throw new Error("The outbox is not enabled; set events: { outbox: true } in quickservicets.config.ts");
  const { adapter, model } = systemTarget(state.adapter, state.model);
  const deliveries = state.deliveryModel ? systemTarget(state.adapter, state.deliveryModel) : undefined;
  const at = event.at instanceof Date ? event.at : new Date(event.at);
  const row: StoredRecord = {
    id: event.id,
    createdAt: at,
    updatedAt: at,
    type: event.type,
    event: JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
    at,
    ...(event.requestId ? { requestId: event.requestId } : {}),
  };
  const trace = eventTraces.get(event);
  if (trace) row.trace = formatTraceparent(trace);
  assertWritable(adapter);
  await adapter.insert(model, row);
  if (deliveries) for (const delivery of deliveryRows(event, at)) await deliveries.adapter.insert(deliveries.model, delivery);
}

/** Runs `fn` in a transaction of the outbox's database. */
export const inOutboxTransaction = <T>(fn: () => Promise<T>) => runInTransaction(outboxStore().adapter, fn);

const MAX_READ = 1000;

const toRecord = (row: StoredRecord): OutboxRecord => {
  const event = { ...(row.event as Record<string, unknown>) };
  event.at = new Date(event.at as string);
  return {
    id: row.id,
    type: row.type as string,
    event: event as unknown as AnyEvent,
    at: row.at instanceof Date ? row.at : new Date(row.at as string),
    ...(typeof row.requestId === "string" ? { requestId: row.requestId } : {}),
  };
};

/**
 * The committed events with an id greater than `after` (the oldest without it), in id order, at most `limit`
 * (default 100, at most 1000), only of the exact `types` when given.
 */
export async function readOutbox(options: { after?: string; limit?: number; types?: readonly string[] } = {}): Promise<OutboxRecord[]> {
  const state = shared.state;
  if (!state) throw new Error("The outbox is not enabled; set events: { outbox: true } in quickservicets.config.ts");
  // The stored events live in the shared table, also when a tenant with its own database reads them.
  const { adapter, model } = systemTarget(state.adapter, state.model);
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), MAX_READ);
  const where = [
    ...(options.after ? [{ field: "id", op: "gt" as const, value: options.after }] : []),
    ...(options.types ? [{ field: "type", op: "in" as const, value: [...options.types] }] : []),
  ];
  const { data } = await adapter.findMany(model, { where, sort: [{ field: "id", direction: "asc" }], limit, offset: 0, withTotal: false });
  return data.map(toRecord);
}

/** The creation time of a UUIDv7, in milliseconds. */
export const timeOfId = (id: string) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

/** The smallest UUIDv7 of a millisecond, below every id created at or after it. */
export function idFloor(ms: number): string {
  const hex = Math.max(0, ms).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

/** How far before its cursor a tail re-reads: ids follow creation, not commit, so late commits land behind it. */
export const TAIL_WINDOW_MS = 5000;

/**
 * Follows the outbox from the event after `from` (the oldest without it): calls `onEvent` once per committed event,
 * re-reading a 5-second window before its cursor on each poll and skipping ids it already saw. Returns a function
 * that stops it.
 */
export function tailOutbox(options: { from?: string; onEvent: (record: OutboxRecord) => void | Promise<void>; pollInterval?: string }): () => void {
  const interval = parseDuration(options.pollInterval ?? "1s") ?? 1000;
  let cursor = options.from;
  const seen = new Map<string, number>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    let after = cursor ? idFloor(timeOfId(cursor) - TAIL_WINDOW_MS) : undefined;
    for (;;) {
      const page = await readOutbox({ ...(after ? { after } : {}), limit: MAX_READ });
      for (const record of page) {
        if (stopped) return;
        if (seen.has(record.id) || (options.from !== undefined && record.id <= options.from)) continue;
        seen.set(record.id, timeOfId(record.id));
        await options.onEvent(record);
        if (!cursor || record.id > cursor) cursor = record.id;
      }
      if (page.length < MAX_READ) break;
      after = page.at(-1)!.id;
    }
    if (cursor) {
      const oldest = timeOfId(cursor) - TAIL_WINDOW_MS;
      for (const [id, time] of seen) if (time < oldest) seen.delete(id);
    }
  };
  const loop = async () => {
    if (stopped) return;
    try {
      await poll();
    } finally {
      if (!stopped) timer = setTimeout(loop, interval);
    }
  };
  void loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Rows deleted per batch by the retention cleanup. */
export const OUTBOX_CLEANUP_BATCH = 1000;

/**
 * Deletes outbox rows older than `retentionMs` before `now`, in batches of 1000; `keep` tells which of them must stay.
 * Resolves with the number deleted.
 */
export async function cleanOutbox(options: {
  retentionMs: number;
  now: number;
  keep?: (ids: string[]) => Promise<Set<string>>;
  removed?: (ids: string[]) => Promise<void>;
}): Promise<number> {
  const { adapter, model } = outboxStore();
  const cutoff = new Date(options.now - options.retentionMs);
  let deleted = 0;
  let after: string | undefined;
  for (;;) {
    const where = [{ field: "at", op: "lt" as const, value: cutoff }, ...(after ? [{ field: "id", op: "gt" as const, value: after }] : [])];
    const { data } = await adapter.findMany(model, { where, sort: [{ field: "id", direction: "asc" }], limit: OUTBOX_CLEANUP_BATCH, offset: 0, withTotal: false });
    if (data.length === 0) return deleted;
    const kept = options.keep ? await options.keep(data.map((row) => row.id)) : new Set<string>();
    const removed: string[] = [];
    for (const row of data) {
      if (kept.has(row.id)) continue;
      if (await adapter.deleteById(model, row.id)) {
        deleted++;
        removed.push(row.id);
      }
    }
    await options.removed?.(removed);
    if (data.length < OUTBOX_CLEANUP_BATCH) return deleted;
    after = data.at(-1)!.id;
  }
}
