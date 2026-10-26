import { parseDuration, reportFailure, safeLog, type AnyEvent, type Condition, type DatabaseAdapter, type EntityModel, type FieldModel, type Logger, type StoredRecord } from "../public.ts";
import { compilePattern, type CompiledPattern } from "./patterns.ts";
import { sharedState } from "./state.ts";

/** The user, tenant and request of an event, as failure reports carry them. */
function actorOf(event: AnyEvent | undefined) {
  if (!event) return {};
  return {
    ...(event.actor.user !== undefined ? { user: { id: event.actor.user } } : {}),
    ...(event.actor.tenant !== undefined ? { tenant: { id: event.actor.tenant } } : {}),
    ...(event.requestId ? { requestId: event.requestId } : {}),
  };
}

/** The states of a delivery row. */
export const DELIVERY_STATUSES = ["pending", "delivering", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** What a durable consumer's handler receives besides the event. */
export interface DeliveryContext {
  /** 1 for the first attempt. */
  attempt: number;
  /** Aborted when the attempt exceeds `outbox.delivery.timeout` or the worker shuts down. */
  signal: AbortSignal;
  /** The service's logger, adding `consumer` and `event` to each entry. */
  log: Logger;
}

/** A durable consumer of outbox events. */
export interface ConsumerOptions {
  /** One or more event patterns. */
  pattern: string | readonly string[];
  /** Delivers one event; resolving marks it delivered, throwing schedules a retry. */
  handler: (event: AnyEvent, ctx: DeliveryContext) => unknown | Promise<unknown>;
  /** Failed attempts before the row becomes `failed` (default `outbox.delivery.retries`). */
  retries?: number;
  /** The first retry delay, doubled each attempt (default `outbox.delivery.retryDelay`). */
  retryDelay?: string;
}

interface Consumer extends ConsumerOptions {
  name: string;
  patterns: CompiledPattern[];
}

/** The delivery settings of `outbox.delivery`. */
export interface DeliverySettings {
  pollInterval: string;
  batch: number;
  timeout: string;
  retries: number;
  retryDelay: string;
  maxRetryDelay: string;
}

const CONSUMER_NAME = /^[a-z][a-z0-9-]*(\/[a-z0-9-]+)*$/;
const consumers = sharedState("consumers", () => new Map<string, Consumer>());

/** Registers a durable consumer; the caller checked that the outbox runs. */
export function registerConsumer(name: string, options: ConsumerOptions): string[] {
  if (typeof name !== "string" || !CONSUMER_NAME.test(name)) throw new Error(`Invalid outbox consumer ${String(name)}: names match ${CONSUMER_NAME.source}`);
  if (consumers.has(name)) throw new Error(`Outbox consumer ${name} is registered twice`);
  if (typeof options?.handler !== "function") throw new Error(`Outbox consumer ${name} needs a handler`);
  const patterns = typeof options.pattern === "string" ? [options.pattern] : [...(options.pattern ?? [])];
  if (patterns.length === 0) throw new Error(`Outbox consumer ${name} needs at least one pattern`);
  consumers.set(name, { ...options, name, patterns: patterns.map(compilePattern) });
  return patterns;
}

/** Removes every consumer; the native calls it when it stops. */
export function clearConsumers(): void {
  consumers.clear();
}

/** The consumers whose patterns match an event type. */
export const consumersOf = (type: string) => [...consumers.values()].filter((consumer) => consumer.patterns.some((pattern) => pattern(type)));

/** The system entity of delivery rows: one per stored event and matching consumer. */
export function outboxDeliveryEntity(): EntityModel {
  const fields: FieldModel[] = [
    { name: "event", type: "string", optional: false, storage: "column" },
    { name: "consumer", type: "string", optional: false, storage: "column" },
    { name: "status", type: "enum", values: [...DELIVERY_STATUSES], optional: false, storage: "column" },
    { name: "attempt", type: "number", optional: false, storage: "column" },
    { name: "nextAttemptAt", type: "date", optional: false, storage: "column" },
    { name: "lockedUntil", type: "date", optional: true, storage: "column" },
    { name: "lastError", type: "string", optional: true, storage: "column" },
    { name: "deliveredAt", type: "date", optional: true, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "OutboxDelivery",
    entityName: "OutboxDelivery",
    schema: null,
    name: "outbox-deliveries",
    repoKey: "outboxDeliveries",
    tableName: "outbox_deliveries",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["event", "consumer"], unique: true }, { fields: ["status", "nextAttemptAt"] }],
    system: true,
  };
}

/** The pending delivery rows of a stored event, one per matching consumer. */
export function deliveryRows(event: AnyEvent, at: Date): StoredRecord[] {
  return consumersOf(event.type).map((consumer) => ({
    id: Bun.randomUUIDv7(),
    createdAt: at,
    updatedAt: at,
    event: event.id,
    consumer: consumer.name,
    status: "pending",
    attempt: 0,
    nextAttemptAt: at,
  }));
}

const condition = (field: string, op: "eq" | "lt" | "lte" | "in", value: unknown): Condition => ({ field, op, value }) as Condition;

export interface DispatcherOptions {
  adapter: DatabaseAdapter;
  outboxModel: EntityModel;
  deliveryModel: EntityModel;
  settings: DeliverySettings;
  logger: Logger;
  /** The time source (default: the system clock). */
  now?: () => number;
}

/** The dispatcher of one worker: claims due delivery rows and calls their consumers. */
export interface Dispatcher {
  /** Claims and delivers one batch; resolves when every delivery of it finished. */
  runOnce(): Promise<void>;
  /** Polls every `pollInterval` until `stop()`. */
  start(): void;
  /** Stops claiming; running deliveries go on. */
  stop(): void;
  /** Resolves once the running deliveries finished, or after `ms`; rows not finished keep their lease. */
  drain(ms: number): Promise<void>;
}

/** Creates the dispatcher of a worker. */
export function createDispatcher({ adapter, outboxModel, deliveryModel, settings, logger, now = Date.now }: DispatcherOptions): Dispatcher {
  const pollMs = parseDuration(settings.pollInterval) ?? 1000;
  const timeoutMs = parseDuration(settings.timeout) ?? 30_000;
  const maxDelayMs = parseDuration(settings.maxRetryDelay) ?? 3_600_000;
  const running = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let claiming = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) =>
    safeLog(logger, level, { timestamp: new Date(now()).toISOString(), message, ...fields });

  /** Claims a due row with a conditional update; null when another instance claimed it first. */
  const claim = async (row: StoredRecord): Promise<StoredRecord | null> => {
    const at = new Date(now());
    const guard = [condition("status", "eq", row.status), condition("attempt", "eq", row.attempt)];
    return adapter.updateById(
      deliveryModel,
      row.id,
      { status: "delivering", attempt: (row.attempt as number) + 1, lockedUntil: new Date(at.getTime() + timeoutMs), updatedAt: at },
      guard,
    );
  };

  /** The due rows: pending ones whose next attempt has come, and delivering ones whose lease expired. */
  const due = async (): Promise<StoredRecord[]> => {
    const at = new Date(now());
    const find = (where: Condition[]) =>
      adapter.findMany(deliveryModel, { where, sort: [{ field: "nextAttemptAt", direction: "asc" }, { field: "id", direction: "asc" }], limit: settings.batch, offset: 0, withTotal: false });
    const pending = await find([condition("status", "eq", "pending"), condition("nextAttemptAt", "lte", at)]);
    const expired = await find([condition("status", "eq", "delivering"), condition("lockedUntil", "lt", at)]);
    return [...pending.data, ...expired.data].slice(0, settings.batch);
  };

  /** Calls the consumer of a claimed row and stores the outcome. */
  const deliver = async (row: StoredRecord, event: AnyEvent | undefined) => {
    const consumer = consumers.get(row.consumer as string);
    const attempt = row.attempt as number;
    const fields = { consumer: row.consumer, event: row.event, type: event?.type, attempt };
    let failure: unknown;
    if (!consumer) failure = new Error(`No outbox consumer ${String(row.consumer)} is registered`);
    else if (!event) failure = new Error(`Outbox event ${String(row.event)} no longer exists`);
    else {
      const controller = new AbortController();
      controllers.add(controller);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const consumerLog: Logger = {
          info: (entry) => logger.info({ ...entry, consumer: consumer.name, event: event.id }),
          warn: (entry) => logger.warn({ ...entry, consumer: consumer.name, event: event.id }),
          error: (entry) => logger.error({ ...entry, consumer: consumer.name, event: event.id }),
        };
        await Promise.race([
          Promise.resolve().then(() => consumer.handler(event, { attempt, signal: controller.signal, log: consumerLog })),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              const error = new Error(`Delivery to ${consumer.name} timed out after ${settings.timeout}`);
              controller.abort(error);
              reject(error);
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
    }
    const at = new Date(now());
    if (failure === undefined) {
      await adapter.updateById(deliveryModel, row.id, { status: "delivered", deliveredAt: at, lockedUntil: null, updatedAt: at }, [condition("attempt", "eq", attempt)]);
      log("info", "events.delivery.delivered", fields);
      return;
    }
    const retries = consumer?.retries ?? settings.retries;
    const lastError = (failure as Error)?.message ?? String(failure);
    if (attempt >= retries) {
      await adapter.updateById(deliveryModel, row.id, { status: "failed", lastError, lockedUntil: null, updatedAt: at }, [condition("attempt", "eq", attempt)]);
      log("error", "events.delivery.failed", { ...fields, error: { message: lastError } });
      reportFailure(failure, { kind: "event", tags: { consumer: String(row.consumer), ...(event?.type ? { event: event.type } : {}) }, ...actorOf(event) });
      return;
    }
    const baseMs = parseDuration(consumer?.retryDelay ?? settings.retryDelay) ?? 10_000;
    const delayMs = Math.min(baseMs * 2 ** (attempt - 1), maxDelayMs);
    await adapter.updateById(
      deliveryModel,
      row.id,
      { status: "pending", nextAttemptAt: new Date(at.getTime() + delayMs), lastError, lockedUntil: null, updatedAt: at },
      [condition("attempt", "eq", attempt)],
    );
    log("warn", "events.delivery.retry", { ...fields, error: { message: lastError } });
  };

  const runOnce = async () => {
    const rows = await due();
    const claimed: StoredRecord[] = [];
    for (const row of rows) {
      const won = await claim(row);
      if (won) claimed.push(won);
    }
    if (claimed.length === 0) return;
    const ids = [...new Set(claimed.map((row) => row.event as string))];
    const { data } = await adapter.findMany(outboxModel, { where: [condition("id", "in", ids)], sort: [{ field: "id", direction: "asc" }], limit: ids.length, offset: 0, withTotal: false });
    const eventsById = new Map(data.map((row) => [row.id, { ...(row.event as Record<string, unknown>), at: new Date((row.event as { at: string }).at) } as unknown as AnyEvent]));
    // Each consumer gets its deliveries in event id order; consumers do not wait for each other.
    const byConsumer = new Map<string, StoredRecord[]>();
    for (const row of claimed.sort((a, b) => String(a.event).localeCompare(String(b.event)))) {
      const list = byConsumer.get(row.consumer as string) ?? [];
      list.push(row);
      byConsumer.set(row.consumer as string, list);
    }
    const work = Promise.all(
      [...byConsumer.values()].map(async (list) => {
        for (const row of list) await deliver(row, eventsById.get(row.event as string));
      }),
    ).then(() => undefined);
    running.add(work);
    try {
      await work;
    } finally {
      running.delete(work);
    }
  };

  const loop = async () => {
    if (!claiming) return;
    try {
      await runOnce();
    } catch (error) {
      log("error", "events.delivery.dispatch-failed", { error: { message: (error as Error)?.message ?? String(error) } });
    } finally {
      if (claiming) timer = setTimeout(loop, pollMs);
    }
  };

  return {
    runOnce,
    start() {
      if (claiming) return;
      claiming = true;
      timer = setTimeout(loop, 0);
    },
    stop() {
      claiming = false;
      clearTimeout(timer);
    },
    async drain(ms) {
      let limit: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...running]), new Promise((resolve) => (limit = setTimeout(resolve, ms)))]);
      clearTimeout(limit);
      for (const controller of controllers) controller.abort(new Error("The worker is shutting down"));
    },
  };
}

/** The ids, among `eventIds`, of events that still have pending, delivering or failed deliveries. */
export async function undeliveredEvents(adapter: DatabaseAdapter, deliveryModel: EntityModel, eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const { data } = await adapter.findMany(deliveryModel, {
    where: [condition("event", "in", eventIds), condition("status", "in", ["pending", "delivering", "failed"])],
    sort: [{ field: "id", direction: "asc" }],
    limit: eventIds.length * Math.max(1, consumers.size) + 1000,
    offset: 0,
    withTotal: false,
  });
  return new Set(data.map((row) => row.event as string));
}

/** Deletes the delivered rows of events the cleanup removes. */
export async function removeDeliveries(adapter: DatabaseAdapter, deliveryModel: EntityModel, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  for (;;) {
    const { data } = await adapter.findMany(deliveryModel, { where: [condition("event", "in", eventIds)], sort: [{ field: "id", direction: "asc" }], limit: 1000, offset: 0, withTotal: false });
    for (const row of data) await adapter.deleteById(deliveryModel, row.id);
    if (data.length < 1000) return;
  }
}
