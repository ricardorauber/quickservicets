import type { RepositoryRegistry } from "./repository.ts";
import { activeSetup } from "./setup-phase.ts";

/** A tenant as runs outside requests see it. */
export interface RunTenant {
  id: string;
  plan?: string;
  status: "active" | "suspended";
  attributes: Record<string, string>;
}

/** What `runForTenant` hands its function: the tenant and the repositories of its database scope. */
export interface TenantRunContext {
  tenant: RunTenant;
  repos: RepositoryRegistry;
}

/** Runs code for tenants outside requests; the `tenancy` native provides it. */
export interface TenantRuns {
  /** Runs `fn` inside the database scope of the tenant `id`; rejects for unknown or suspended tenants. */
  run<T>(id: string, fn: (context: TenantRunContext) => T | Promise<T>): Promise<T>;
  /** Every tenant of the directory. */
  list(): AsyncIterable<RunTenant>;
  /** Closes what runs opened (tenant database pools), for processes that do not start the service. */
  close?(): Promise<void>;
}

let current: TenantRuns | undefined;

/** Sets the tenant runs of the service; `createApp` calls it with what the features' setups gave. */
export function configureTenantRuns(runs: TenantRuns | undefined): void {
  current = runs;
}

/** Gives the service's tenant runs; only during a feature's setup. */
export function setTenantRuns(runs: TenantRuns): void {
  const setup = activeSetup();
  if (!setup) throw new Error("setTenantRuns() is only available during feature setup");
  setup.server.tenantRuns = runs;
}

/** The tenant runs of the running service, or undefined without tenancy. */
export function tenantRuns(): TenantRuns | undefined {
  return current;
}

/**
 * Runs `fn({ tenant, repos })` inside the database scope (schema or database) and operation context of the tenant
 * `id`, resolving its result; rejects with `Unknown tenant <id>` or `Tenant <id> is suspended`.
 */
export function runForTenant<T>(id: string, fn: (context: TenantRunContext) => T | Promise<T>): Promise<T> {
  if (!current) return Promise.reject(new Error("runForTenant() needs a running service with tenancy enabled"));
  return current.run(id, fn);
}
