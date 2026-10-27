import type { TenantInfo } from "./directory.ts";
import type { PoolStats } from "./pools.ts";
import type { TenantProvisionResult } from "./tenants.ts";
import type { FeatureHook, ServiceRequest, TenantRunContext } from "../public.ts";
import type { TenantDirectory } from "./directory.ts";

/** Finds the tenant id of a request, replacing the sources of `tenancy.from` (`tenancy.resolver`). */
export interface TenantResolver {
  resolve(input: { req: ServiceRequest; url: URL; user: ServiceRequest["user"] }): string | undefined | null | Promise<string | undefined | null>;
}

/** The feature API of `tenancy`, reached with `ctx.feature("tenancy")` from a feature that lists `tenancy` in `requires` or `after`. */
export interface TenancyApi {
  /**
   * Exempts the paths matching `pattern` (a path, or a path ending in `/*` for it and every path below it) from tenant
   * resolution: their requests get no `req.tenant` and need none. Only available during setup.
   */
  exempt(pattern: string): void;
  /** The tenant with this id from the directory, through the worker's cache, or undefined when there is none. */
  find(id: string): Promise<TenantInfo | undefined>;
  /** Every tenant of the directory, read page by page without the cache. */
  list(): AsyncIterable<TenantInfo>;
  /** The tenant database pools of this worker: open, the limit, openings in progress and tenants failing to open. */
  stats(): PoolStats;
  /** Creates a tenant of the database source and migrates it; refuses an existing id with `Tenant <id> already exists`. */
  provision(info: Partial<TenantInfo> & { id: string }): Promise<TenantProvisionResult>;
  /**
   * Runs `fn({ tenant, repos })` inside the database scope of the tenant `id`, like `runForTenant`; rejects for unknown
   * and suspended tenants.
   */
  run<T>(id: string, fn: (context: TenantRunContext) => T | Promise<T>): Promise<T>;
  /** Applies the pending migrations to one tenant; rejects with `Unknown tenant <id>` for an unknown one. */
  migrate(id: string): Promise<TenantProvisionResult>;
  /** Replaces the directory source, keeping the cache; only during setup, and only once (the config's `directory` counts). */
  setDirectory(directory: TenantDirectory): void;
  /** Appends a `beforeResolve` hook after the config's: returning another id replaces it, null drops it. */
  addHook(name: "beforeResolve", fn: FeatureHook<{ id: string | undefined; source: string | undefined; req: ServiceRequest }, undefined>): void;
  /** Appends an `afterResolve` hook after the config's. */
  addHook(name: "afterResolve", fn: FeatureHook<{ tenant: TenantInfo; req: ServiceRequest }, undefined>): void;
  /** Appends an `onUnknownTenant` hook after the config's. */
  addHook(name: "onUnknownTenant", fn: FeatureHook<{ id: string; req: ServiceRequest }, undefined>): void;
  /** Appends an `onPoolOpen` or `onPoolClose` hook after the config's. */
  addHook(name: "onPoolOpen" | "onPoolClose", fn: FeatureHook<{ tenant: string; reason?: string }, undefined>): void;
}
