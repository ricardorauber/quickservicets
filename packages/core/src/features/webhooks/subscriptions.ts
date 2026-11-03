import { currentTenant, HttpError, safeLog, ssrfProblem, systemTarget, type Condition, type DatabaseAdapter, type EntityModel, type Logger, type StoredRecord } from "../public.ts";
import type { DeliverableEvents } from "./deliverable.ts";
import { patternProblem } from "./deliverable.ts";

/** A webhook subscription as reads return it, without its secrets. */
export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  description?: string;
  previousSecretExpiresAt?: Date | null;
  enabled: boolean;
  disabledReason?: string | null;
  failingSince?: Date | null;
  headers?: Record<string, string> | null;
  tenant?: string | null;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A subscription as the native stores it, secrets included. */
export interface StoredSubscription extends WebhookSubscription {
  secret: string;
  previousSecret?: string | null;
}

/** What `subscriptions.create` takes. */
export interface CreateSubscriptionInput {
  url: string;
  events: string[];
  description?: string;
  headers?: Record<string, string>;
  tenant?: string;
  createdBy?: string;
}

/** What `subscriptions.update` may change. */
export interface UpdateSubscriptionInput {
  url?: string;
  events?: string[];
  description?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** A page of subscriptions. */
export interface SubscriptionListOptions {
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

/** Manages webhook subscriptions from code: `webhooks.subscriptions` and `ctx.feature("webhooks").subscriptions`. */
export interface WebhookSubscriptions {
  /** Creates a subscription and resolves it with its secret, which reads never return again. */
  create(input: CreateSubscriptionInput): Promise<WebhookSubscription & { secret: string }>;
  /** The subscriptions of the current tenant (every one outside tenant scopes), newest first. */
  list(options?: SubscriptionListOptions): Promise<{ data: WebhookSubscription[]; total: number; limit: number; offset: number }>;
  /** One subscription; throws `Webhook subscription <id> not found`. */
  get(id: string): Promise<WebhookSubscription>;
  /** Changes a subscription's url, events, description, headers or enabled; enabling clears why it was disabled. */
  update(id: string, changes: UpdateSubscriptionInput): Promise<WebhookSubscription>;
  /** Deletes a subscription. */
  delete(id: string): Promise<void>;
  /** Replaces the secret, keeping the old one valid for 24 hours, and resolves the new one. */
  rotateSecret(id: string): Promise<{ secret: string; previousSecretExpiresAt: Date }>;
  /**
   * Sends a signed `webhook.ping` event to the subscription at once, without a delivery record, and resolves the
   * receiver's status; at most 10 per minute per subscription (429 `Too many requests` beyond).
   */
  ping(id: string): Promise<{ status: number; ok: boolean; durationMs: number }>;
}

/** How long a rotated secret keeps signing deliveries next to the new one. */
export const PREVIOUS_SECRET_MS = 24 * 3_600_000;

/** A new secret: `whsec_` and the base64 of 24 random bytes. */
export function generateSecret(): string {
  return `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64")}`;
}

const invalid = (field: string, message: string) => new HttpError(400, "Invalid body", { details: [{ field, message }] });
const condition = (field: string, op: "eq", value: unknown): Condition => ({ field, op, value }) as Condition;

/** Why a subscription URL is refused, or undefined when it is accepted. */
export async function urlProblem(value: unknown, requireHttps: boolean): Promise<string | undefined> {
  if (typeof value !== "string" || value === "") return "Is required";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Must be an absolute URL";
  }
  if (url.protocol !== "https:" && (requireHttps || url.protocol !== "http:")) return requireHttps ? "Must be an https URL" : "Must be an http or https URL";
  if (url.username !== "" || url.password !== "") return "Must not contain credentials";
  if (await ssrfProblem(url)) return "Address is not allowed";
  return undefined;
}

/** Why a list of subscription patterns is refused, or undefined when every pattern matches a deliverable event. */
export function eventsProblem(value: unknown, deliverable: DeliverableEvents): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return "Is required";
  for (const pattern of value) {
    if (patternProblem(pattern) !== undefined || !deliverable.matchesAny(pattern)) return `Event ${String(pattern)} is not available for webhooks`;
  }
  return undefined;
}

/** Why a headers record is refused, or undefined. */
function headersProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.values(value).every((item) => typeof item === "string")) return "Must be an object of texts";
  return undefined;
}

/** A stored subscription without its secrets. */
export function publicSubscription(record: StoredRecord | StoredSubscription): WebhookSubscription {
  const { secret: _secret, previousSecret: _previous, ...rest } = record as StoredSubscription;
  return rest as WebhookSubscription;
}

/** What the subscription store needs from the running native. */
export interface SubscriptionStoreOptions {
  adapter: DatabaseAdapter;
  model: EntityModel;
  requireHttps: boolean;
  deliverable: DeliverableEvents;
  logger: Logger;
  /** Called after each change, and awaited, so this worker's cache of subscriptions sees it at once. */
  changed?: () => void | Promise<void>;
  /** Called before a subscription is deleted, to delete what belongs to it. */
  deleting?: (id: string) => Promise<void>;
  now?: () => number;
}

/** The subscriptions of the project's database, scoped to the current tenant. */
export function subscriptionStore(options: SubscriptionStoreOptions) {
  const { model, deliverable } = options;
  const now = options.now ?? Date.now;
  const db = () => systemTarget(options.adapter, model).adapter;
  const notFound = (id: string) => new HttpError(404, `Webhook subscription ${id} not found`);
  const scoped = (): Condition[] => {
    const tenant = currentTenant()?.id;
    return tenant === undefined ? [] : [condition("tenant", "eq", tenant)];
  };
  const find = async (id: string): Promise<StoredSubscription> => {
    const tenant = currentTenant()?.id;
    const found = (await db().findById(model, id)) as unknown as StoredSubscription | null;
    if (!found || (tenant !== undefined && found.tenant !== tenant)) throw notFound(id);
    return found;
  };
  const changed = async () => {
    try {
      await options.changed?.();
    } catch (error) {
      safeLog(options.logger, "warn", { timestamp: new Date().toISOString(), message: "webhooks.cache.failed", error: { message: (error as Error)?.message ?? String(error) } });
    }
  };
  const store = {
    /** A subscription with its secrets, whatever the scope; for the native's delivery code. */
    async stored(id: string): Promise<StoredSubscription | null> {
      return (await db().findById(model, id)) as unknown as StoredSubscription | null;
    },
    /** Every enabled subscription, for the per-worker cache. */
    async enabled(): Promise<StoredSubscription[]> {
      const rows: StoredSubscription[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data } = await options.adapter.findMany(model, { where: [condition("enabled", "eq", true)], sort: [{ field: "id", direction: "asc" }], limit: 1000, offset, withTotal: false });
        rows.push(...(data as unknown as StoredSubscription[]));
        if (data.length < 1000) return rows;
      }
    },
    /** Changes stored fields of a subscription without checks; for the native's delivery code. */
    async patch(id: string, changes: Record<string, unknown>): Promise<StoredSubscription | null> {
      const updated = (await db().updateById(model, id, { ...changes, updatedAt: new Date(now()) })) as unknown as StoredSubscription | null;
      await changed();
      return updated;
    },
  };
  const api: Omit<WebhookSubscriptions, "ping"> = {
    async create(input) {
      const urlReason = await urlProblem(input?.url, options.requireHttps);
      if (urlReason) throw invalid("url", urlReason);
      const eventsReason = eventsProblem(input.events, deliverable);
      if (eventsReason) throw invalid("events", eventsReason);
      const headersReason = headersProblem(input.headers);
      if (headersReason) throw invalid("headers", headersReason);
      const at = new Date(now());
      const tenant = input.tenant ?? currentTenant()?.id;
      const row: StoredRecord = {
        id: Bun.randomUUIDv7(),
        createdAt: at,
        updatedAt: at,
        url: input.url,
        events: [...input.events],
        secret: generateSecret(),
        enabled: true,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.headers !== undefined ? { headers: { ...input.headers } } : {}),
        ...(tenant !== undefined ? { tenant } : {}),
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
      };
      const created = (await db().insert(model, row)) as unknown as StoredSubscription;
      await changed();
      return { ...publicSubscription(created), secret: created.secret };
    },
    async list(page = {}) {
      const limit = Math.min(Math.max(Math.trunc(page.limit ?? 20), 1), 100);
      const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
      const where = [...scoped(), ...(page.enabled !== undefined ? [condition("enabled", "eq", page.enabled)] : [])];
      const found = await db().findMany(model, { where, sort: [{ field: "createdAt", direction: "desc" }, { field: "id", direction: "desc" }], limit, offset });
      return { data: found.data.map(publicSubscription), total: found.total, limit, offset };
    },
    async get(id) {
      return publicSubscription(await find(id));
    },
    async update(id, input) {
      const existing = await find(id);
      const changes: Record<string, unknown> = {};
      if (input.url !== undefined) {
        const reason = await urlProblem(input.url, options.requireHttps);
        if (reason) throw invalid("url", reason);
        changes.url = input.url;
      }
      if (input.events !== undefined) {
        const reason = eventsProblem(input.events, deliverable);
        if (reason) throw invalid("events", reason);
        changes.events = [...input.events];
      }
      if (input.description !== undefined) changes.description = input.description;
      if (input.headers !== undefined) {
        const reason = headersProblem(input.headers);
        if (reason) throw invalid("headers", reason);
        changes.headers = { ...input.headers };
      }
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== "boolean") throw invalid("enabled", "Must be a boolean");
        changes.enabled = input.enabled;
        if (input.enabled) {
          changes.disabledReason = null;
          changes.failingSince = null;
        }
      }
      const updated = (await db().updateById(model, existing.id, { ...changes, updatedAt: new Date(now()) })) as unknown as StoredSubscription | null;
      if (!updated) throw notFound(id);
      await changed();
      return publicSubscription(updated);
    },
    async delete(id) {
      const existing = await find(id);
      await options.deleting?.(existing.id);
      await db().deleteById(model, existing.id);
      await changed();
    },
    async rotateSecret(id) {
      const existing = await find(id);
      const secret = generateSecret();
      const previousSecretExpiresAt = new Date(now() + PREVIOUS_SECRET_MS);
      await db().updateById(model, existing.id, { secret, previousSecret: existing.secret, previousSecretExpiresAt, updatedAt: new Date(now()) });
      await changed();
      return { secret, previousSecretExpiresAt };
    },
  };
  return { api, ...store };
}

export type SubscriptionStore = ReturnType<typeof subscriptionStore>;
