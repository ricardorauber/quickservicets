import { entityModel, field, http, HttpError, safeLog, type DatabaseAdapter, type EntityModel, type Logger, type StoredRecord } from "../public.ts";
import { TENANT_ID } from "./resolve.ts";

/** What the service knows of a tenant. `connection` is a secret: it never reaches `req.tenant`, logs or reports. */
export interface TenantInfo {
  id: string;
  plan?: string;
  strategy?: "schema" | "database";
  schema?: string;
  /** A connection text, or an object for the adapter, of a database-strategy tenant. */
  connection?: unknown;
  status: "active" | "suspended";
  attributes: Record<string, string>;
}

/** Where tenants are looked up: one tenant by id, or every tenant. */
export interface TenantDirectory {
  /** The tenant with this id, or undefined when there is none; a throw counts as a failed lookup. */
  find(id: string): Promise<TenantInfo | undefined>;
  /** Every tenant, in pages if the source has them. */
  list(): AsyncIterable<TenantInfo>;
}

/** The time source of the directory cache; tests replace `now`. */
export const directoryClock = { now: () => Date.now() };

export const tenantNotFound = () => new HttpError(404, "Tenant not found", { code: "TENANT_NOT_FOUND" });
export const tenantSuspended = () => new HttpError(403, "Tenant is suspended", { code: "TENANT_SUSPENDED" });
export const directoryUnavailable = () => new HttpError(503, "Tenant directory is unavailable", { code: "TENANT_DIRECTORY_UNAVAILABLE", headers: { "retry-after": "5" } });

/** The fields of the `Tenant` entity the native reads, with their types. */
export const TENANT_FIELDS = {
  key: field({ type: "string", unique: true }),
  plan: field({ type: "string", optional: true }),
  strategy: field({ type: "enum", values: ["schema", "database"], optional: true }),
  schema: field({ type: "string", optional: true }),
  connection: { ...field({ type: "string", optional: true }), hidden: true, tags: { sensitive: { on: true, options: {} } } },
  status: field({ type: "enum", values: ["active", "suspended"], default: "active" }),
  attributes: field({ type: "json", optional: true }),
};

/** The internal entity of the database source: one row per tenant, writable from code, without routes, shared by every tenant. */
export function tenantEntity(): EntityModel {
  return entityModel("Tenant", TENANT_FIELDS as never, { internal: true });
}

/** The attributes of a tenant as texts. */
function attributesOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined && item !== null).map(([key, item]) => [key, String(item)]));
}

/** A tenant from a stored row, a config entry or a service answer; throws on a shape that is not a tenant. */
export function tenantInfoOf(id: string, value: Record<string, unknown>): TenantInfo {
  const status = value.status ?? "active";
  if (status !== "active" && status !== "suspended") throw new Error(`Invalid tenant ${id}: status must be active or suspended`);
  const strategy = value.strategy ?? undefined;
  if (strategy !== undefined && strategy !== null && strategy !== "schema" && strategy !== "database") throw new Error(`Invalid tenant ${id}: strategy must be schema or database`);
  const info: TenantInfo = { id, status, attributes: attributesOf(value.attributes) };
  if (typeof value.plan === "string") info.plan = value.plan;
  if (typeof strategy === "string") info.strategy = strategy as TenantInfo["strategy"];
  if (typeof value.schema === "string") info.schema = value.schema;
  if (value.connection !== undefined && value.connection !== null) info.connection = value.connection;
  return info;
}

/** The tenants of the config, by id. */
export function configDirectory(tenants: Record<string, Record<string, unknown>>): TenantDirectory {
  const entries = new Map(Object.entries(tenants ?? {}).map(([id, value]) => [id, tenantInfoOf(id, value ?? {})]));
  return {
    find: async (id) => entries.get(id),
    async *list() {
      yield* entries.values();
    },
  };
}

/** The `Tenant` rows of the service's own database. */
export function databaseDirectory(adapter: DatabaseAdapter, model: EntityModel): TenantDirectory {
  const ofRow = (row: StoredRecord) => tenantInfoOf(String(row.key), row);
  return {
    async find(id) {
      const row = await adapter.findOne(model, [{ field: "key", op: "eq", value: id }]);
      return row ? ofRow(row) : undefined;
    },
    async *list() {
      for (let offset = 0; ; offset += 1000) {
        const { data } = await adapter.findMany(model, { where: [], sort: [{ field: "key", direction: "asc" }], limit: 1000, offset, withTotal: false });
        for (const row of data) yield ofRow(row);
        if (data.length < 1000) return;
      }
    },
  };
}

/**
 * The tenants another service knows, through the named HTTP service: `GET /tenants/<id>` answers a tenant (200) or
 * none (404), and `GET /tenants?cursor=<c>` a page `{ data, next? }`; any other answer is a failure.
 */
export function serviceDirectory(service: string): TenantDirectory {
  return {
    async find(id) {
      const response = await http.service(service as never).get(`/tenants/${encodeURIComponent(id)}`).response();
      if (response.status === 404) return undefined;
      if (response.status !== 200) throw new Error(`The tenant directory service ${service} answered ${response.status}`);
      const body = await response.json<Record<string, unknown>>();
      if (!body || typeof body !== "object") throw new Error(`The tenant directory service ${service} answered a tenant that is not an object`);
      return tenantInfoOf(id, body);
    },
    async *list() {
      let cursor: string | undefined;
      do {
        const request = http.service(service as never).get("/tenants");
        const response = await (cursor === undefined ? request : request.query({ cursor })).response();
        if (response.status !== 200) throw new Error(`The tenant directory service ${service} answered ${response.status}`);
        const page = await response.json<{ data?: Record<string, unknown>[]; next?: string | null }>();
        if (!page || !Array.isArray(page.data)) throw new Error(`The tenant directory service ${service} answered a page without data`);
        for (const item of page.data) yield tenantInfoOf(String(item.id), item);
        cursor = typeof page.next === "string" && page.next !== "" ? page.next : undefined;
      } while (cursor !== undefined);
    },
  };
}

export interface DirectoryCacheOptions {
  ttl: number;
  negativeTtl: number;
  staleTtl: number;
  maxEntries: number;
}

interface CacheEntry {
  info: TenantInfo | null;
  at: number;
}

/** Thrown when a lookup failed and no cached entry is young enough to use instead. */
export class TenantDirectoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Tenant directory is unavailable", { cause });
    this.name = "TenantDirectoryUnavailableError";
  }
}

/** A directory with a per-worker cache: what `find` and `list` of the feature API use. */
export interface CachedDirectory extends TenantDirectory {
  /** Replaces the cached entry of a tenant (a written row) or drops it (undefined). */
  remember(id: string, info: TenantInfo | undefined): void;
  /** Forgets every cached entry. */
  clear(): void;
}

/**
 * Caches the lookups of `source` per worker: tenants for `ttl`, unknown ids for `negativeTtl`, the least recently used
 * beyond `maxEntries`, with one lookup in flight per id. A failed lookup uses a cached entry younger than `staleTtl`,
 * logging `tenancy.directory.stale` once per id and minute, and throws `TenantDirectoryUnavailableError` otherwise.
 */
export function cachedDirectory(source: () => TenantDirectory, options: DirectoryCacheOptions, logger: Logger): CachedDirectory {
  const entries = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<TenantInfo | undefined>>();
  const staleLogged = new Map<string, number>();
  const store = (id: string, info: TenantInfo | null) => {
    entries.delete(id);
    entries.set(id, { info, at: directoryClock.now() });
    while (entries.size > options.maxEntries) entries.delete(entries.keys().next().value!);
  };
  const lookup = (id: string, cached: CacheEntry | undefined): Promise<TenantInfo | undefined> => {
    const running = inFlight.get(id);
    if (running) return running;
    const work = (async () => {
      try {
        const info = await source().find(id);
        store(id, info ?? null);
        return info;
      } catch (error) {
        const now = directoryClock.now();
        if (cached && now - cached.at < options.staleTtl) {
          const last = staleLogged.get(id);
          if (last === undefined || now - last >= 60_000) {
            staleLogged.set(id, now);
            safeLog(logger, "warn", { timestamp: new Date(now).toISOString(), message: "tenancy.directory.stale", tenant: id, error: { message: (error as Error)?.message ?? String(error) } });
          }
          return cached.info ?? undefined;
        }
        throw new TenantDirectoryUnavailableError(error);
      } finally {
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, work);
    return work;
  };
  return {
    find(id) {
      const cached = entries.get(id);
      if (cached) {
        const age = directoryClock.now() - cached.at;
        if (age < (cached.info ? options.ttl : options.negativeTtl)) {
          entries.delete(id);
          entries.set(id, cached);
          return Promise.resolve(cached.info ?? undefined);
        }
      }
      return lookup(id, cached);
    },
    list: () => source().list(),
    remember(id, info) {
      if (info) store(id, info);
      else entries.delete(id);
    },
    clear: () => entries.clear(),
  };
}

/** Whether a text is a valid tenant id. */
export const isTenantId = (value: unknown): value is string => typeof value === "string" && TENANT_ID.test(value);
