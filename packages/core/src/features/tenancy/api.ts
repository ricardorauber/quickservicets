import type { TenantInfo } from "./directory.ts";

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
}
