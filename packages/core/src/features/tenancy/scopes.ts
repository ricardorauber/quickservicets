import { currentDatabaseScope, HttpError, safeLog, schemaIdentifier, tenantRepositories, type DatabaseAdapter, type DatabaseScope, type EntityModel, type Logger } from "../public.ts";
import type { TenantInfo } from "./directory.ts";

/** The names `withSchema` accepts. */
const SCHEMA_NAME = /^[a-z][a-z0-9-]*$/;

export const tenantNotReady = () => new HttpError(503, "Tenant is not ready", { code: "TENANT_UNAVAILABLE", headers: { "retry-after": "30" } });

/** The schema of a schema-strategy tenant: its own `schema`, or the template with `{tenant}` replaced by its id. */
export function schemaNameOf(tenant: TenantInfo, template: string): string {
  return tenant.schema ?? template.replaceAll("{tenant}", tenant.id);
}

/** Whether an error says a table (or a whole tenant schema) does not exist yet. */
export function isMissingTable(error: unknown): boolean {
  let current = error as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && typeof current === "object" && depth < 10; depth++) {
    if (current.code === "42P01" || current.errno === "42P01") return true;
    if (typeof current.message === "string" && /no such table/.test(current.message)) return true;
    current = current.cause as typeof current;
  }
  return false;
}

export interface TenantScopesOptions {
  /** The service's own database: the parent of every schema view. */
  root: DatabaseAdapter;
  models: readonly EntityModel[];
  /** The root default schema (`DATABASE_SCHEMA`), which no tenant may use. */
  defaultSchema: string | null | undefined;
  /** The `tenancy.schema` template. */
  template: string;
  logger: Logger;
}

/**
 * The database scope of each tenant, built on its first request and kept per tenant id and schema, so a request of a
 * known tenant costs one map lookup.
 */
export function tenantScopes(options: TenantScopesOptions) {
  const scopes = new Map<string, DatabaseScope>();
  const taken = new Set(options.models.flatMap((model) => (model.schema ? [schemaIdentifier(model.schema)] : [])));
  if (options.defaultSchema) taken.add(schemaIdentifier(options.defaultSchema));
  const conflict = (tenant: TenantInfo, name: string) => {
    safeLog(options.logger, "error", { timestamp: new Date().toISOString(), message: "tenancy.schema.conflict", tenant: tenant.id, schema: name });
    return new HttpError(500, "Internal server error");
  };
  return {
    /** The scope of a tenant whose data lives in a schema of the service's database. */
    schema(tenant: TenantInfo): DatabaseScope {
      const name = schemaNameOf(tenant, options.template);
      const key = `${tenant.id}\u0000${name}`;
      const found = scopes.get(key);
      if (found) return found;
      if (!SCHEMA_NAME.test(name) || taken.has(schemaIdentifier(name))) throw conflict(tenant, name);
      const adapter = options.root.withSchema!(name);
      // The root scope's registry holds the shared repositories every tenant uses.
      const repos = tenantRepositories(currentDatabaseScope().repos, adapter);
      const scope: DatabaseScope = { key: `tenant:${tenant.id}`, adapter, repos, tenant: { id: tenant.id, ...(tenant.plan !== undefined ? { plan: tenant.plan } : {}) } };
      scopes.set(key, scope);
      return scope;
    },
    /** Logs a tenant whose tables do not exist yet, and the answer of its request. */
    notReady(tenant: TenantInfo): HttpError {
      safeLog(options.logger, "warn", { timestamp: new Date().toISOString(), message: "tenancy.tenant.not-provisioned", tenant: tenant.id, hint: `run quickservicets migrate --tenant ${tenant.id}` });
      return tenantNotReady();
    },
  };
}
