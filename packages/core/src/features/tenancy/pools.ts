import { HttpError, safeLog, SECRET_MASK, type DatabaseAdapter, type EntityModel, type Logger } from "../public.ts";
import { directoryClock, type TenantInfo } from "./directory.ts";

/** How long new openings of a tenant wait after its last failure. */
export const RETRY_AFTER_FAILURE_MS = 10_000;

export const poolsBusy = () => new HttpError(503, "Too many tenant databases are busy", { code: "TENANT_UNAVAILABLE", headers: { "retry-after": "5" } });
export const databaseUnavailable = () => new HttpError(503, "Tenant database is unavailable", { code: "TENANT_UNAVAILABLE", headers: { "retry-after": "30" } });

/** Why a pool closed. */
export type PoolCloseReason = "idle" | "evicted" | "shutdown" | "failed" | "changed";

export interface PoolSettings {
  max: number;
  connections: number;
  idleMs: number;
  connectTimeoutMs: number;
}

/** What the pools report to `stats()`: the open pools, the limit, the openings in progress and the tenants failing. */
export interface PoolStats {
  open: number;
  max: number;
  opening: number;
  failed: number;
}

/** One open pool of a tenant database. */
export interface TenantPool {
  tenant: string;
  adapter: DatabaseAdapter;
  /** The connection the pool was opened with, compared when the connection changes; never logged. */
  connection: unknown;
  /** Requests and runs using the pool now. */
  active: number;
  lastUsed: number;
}

/** A pool lent to one request or run, until `release`. */
export interface PoolLease {
  pool: TenantPool;
  release(): void;
}

export interface TenantPoolsOptions {
  /** The service's own database, whose `forConnection` opens tenant databases. */
  root: DatabaseAdapter;
  /** The models stored in tenant databases. */
  tenantModels: readonly EntityModel[];
  workers: number;
  settings: PoolSettings;
  logger: Logger;
  /** The connection of a tenant; undefined when it has none. */
  connectionOf(tenant: TenantInfo): Promise<unknown>;
  /** Runs after a pool opened or closed, like the onPoolOpen and onPoolClose hooks. */
  onOpen?(tenant: TenantInfo, pool: TenantPool): void | Promise<void>;
  onClose?(tenant: string, reason: PoolCloseReason): void | Promise<void>;
}

/** Replaces every text of `secrets` and the password of any URL in `message` with the secret mask. */
export function maskConnections(message: string, secrets: readonly unknown[]): string {
  let masked = message;
  for (const secret of secrets) {
    const texts = typeof secret === "string" ? [secret] : secret && typeof secret === "object" ? Object.values(secret).filter((value): value is string => typeof value === "string") : [];
    for (const text of texts) if (text.length >= 4) masked = masked.split(text).join(SECRET_MASK);
  }
  return masked.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*):[^@/\s]*@/gi, `$1:${SECRET_MASK}@`);
}

/** Rejects with an error after `ms`, or resolves with `work`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`connecting timed out after ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The tenant database pools of one worker: opened on first use (one opening per tenant at a time), at most
 * `settings.max` open, the least recently used idle one closed to make room, idle ones closed after `idleMs`, and new
 * openings of a failing tenant spaced by 10 seconds.
 */
export function tenantPools(options: TenantPoolsOptions) {
  const { settings, logger } = options;
  const pools = new Map<string, TenantPool>();
  const opening = new Map<string, Promise<TenantPool>>();
  const failures = new Map<string, number>();
  /** Pools replaced by a new connection, closed once their requests finish. */
  const retiring = new Set<TenantPool>();
  const now = () => directoryClock.now();
  const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) =>
    safeLog(logger, level, { timestamp: new Date(now()).toISOString(), message, ...fields });

  const close = async (pool: TenantPool, reason: PoolCloseReason) => {
    if (pools.get(pool.tenant) === pool) pools.delete(pool.tenant);
    retiring.delete(pool);
    try {
      await pool.adapter.disconnect();
    } catch (error) {
      log("warn", "tenancy.pool.close-failed", { tenant: pool.tenant, error: { message: maskConnections((error as Error)?.message ?? String(error), [pool.connection]) } });
    }
    log("info", "tenancy.pool.closed", { tenant: pool.tenant, reason });
    await options.onClose?.(pool.tenant, reason);
  };

  /** Closes the pools unused for longer than `idleMs`. */
  const sweep = async () => {
    const at = now();
    for (const pool of [...pools.values()]) if (pool.active === 0 && at - pool.lastUsed >= settings.idleMs) await close(pool, "idle");
  };

  /** Makes room for one more pool: closes the least recently used idle pool, or answers busy. */
  const makeRoom = async () => {
    if (pools.size + opening.size < settings.max) return;
    const idle = [...pools.values()].filter((pool) => pool.active === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) throw poolsBusy();
    await close(idle, "evicted");
  };

  const open = (tenant: TenantInfo, connection: unknown): Promise<TenantPool> => {
    const running = opening.get(tenant.id);
    if (running) return running;
    const work = (async () => {
      const failedAt = failures.get(tenant.id);
      if (failedAt !== undefined && now() - failedAt < RETRY_AFTER_FAILURE_MS) throw databaseUnavailable();
      await makeRoom();
      if (!options.root.forConnection) throw new Error(`tenancy strategy "database" needs an adapter with forConnection(); the ${options.root.kind ?? "configured"} adapter has none`);
      const adapter = options.root.forConnection(connection);
      try {
        // Drivers that connect lazily are checked with a round trip, so an unreachable database fails here.
        const connecting = async () => {
          await adapter.connect([...options.tenantModels], { workers: options.workers, poolSize: settings.connections });
          await adapter.ping?.();
        };
        await within(connecting(), settings.connectTimeoutMs);
      } catch (error) {
        failures.set(tenant.id, now());
        log("error", "tenancy.pool.failed", { tenant: tenant.id, error: { message: maskConnections((error as Error)?.message ?? String(error), [connection]) } });
        void adapter.disconnect().catch(() => {});
        throw Object.assign(databaseUnavailable(), { cause: error });
      }
      failures.delete(tenant.id);
      const pool: TenantPool = { tenant: tenant.id, adapter, connection, active: 0, lastUsed: now() };
      pools.set(tenant.id, pool);
      log("info", "tenancy.pool.opened", { tenant: tenant.id });
      await options.onOpen?.(tenant, pool);
      return pool;
    })();
    opening.set(tenant.id, work);
    const done = () => opening.delete(tenant.id);
    work.then(done, done);
    return work;
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    /** The connection of a tenant's database; answers 503 when it has none. */
    async connectionOf(tenant: TenantInfo): Promise<unknown> {
      const connection = await options.connectionOf(tenant);
      if (connection === undefined || connection === null || connection === "") throw databaseUnavailable();
      return connection;
    },
    /**
     * Lends the open pool of a tenant, opening it first; a pool open with another connection is retired and a new one
     * opened. Answers 503 when the database cannot be reached or every pool is busy.
     */
    async acquire(tenant: TenantInfo, connection: unknown): Promise<PoolLease> {
      await sweep();
      let pool = pools.get(tenant.id);
      if (pool && pool.connection !== connection && JSON.stringify(pool.connection) !== JSON.stringify(connection)) {
        pools.delete(tenant.id);
        retiring.add(pool);
        log("info", "tenancy.connection.changed", { tenant: tenant.id });
        if (pool.active === 0) await close(pool, "changed");
        pool = undefined;
      }
      pool ??= await open(tenant, connection);
      const lent = pool;
      lent.active++;
      lent.lastUsed = now();
      let released = false;
      return {
        pool: lent,
        release() {
          if (released) return;
          released = true;
          lent.active--;
          lent.lastUsed = now();
          if (lent.active === 0 && retiring.has(lent)) void close(lent, "changed");
        },
      };
    },
    /** The open pool of a tenant, without opening it. */
    get: (id: string) => pools.get(id),
    stats(): PoolStats {
      const at = now();
      const failed = [...failures.values()].filter((when) => at - when < RETRY_AFTER_FAILURE_MS).length;
      return { open: pools.size, max: settings.max, opening: opening.size, failed };
    },
    sweep,
    /** Starts closing idle pools on a timer. */
    start() {
      timer = setInterval(() => void sweep(), Math.max(1000, Math.min(settings.idleMs, 60_000)));
      timer.unref?.();
    },
    /** Closes every pool once its requests finish, waiting at most `timeoutMs` for them. */
    async closeAll(timeoutMs: number) {
      clearInterval(timer);
      const deadline = Date.now() + timeoutMs;
      const all = [...pools.values(), ...retiring];
      while (all.some((pool) => pool.active > 0) && Date.now() < deadline) await Bun.sleep(10);
      for (const pool of all) await close(pool, "shutdown");
    },
  };
}

export type TenantPools = ReturnType<typeof tenantPools>;
