import type { DatabaseAdapter } from "./adapter.ts";
import { currentDatabaseScope } from "./database-scope.ts";
import { HttpError } from "./errors.ts";
import type { EntityModel } from "./model.ts";
import { publicTransaction } from "./transactions.ts";
import { configuredModels, repositoriesFor, repositoryLookup, type Repository, type RepositoryRegistry } from "./repository.ts";

/**
 * Thrown when code running without a tenant (the root database scope) uses the repository of an entity that holds
 * tenant data; a request answers it as 400 `TENANT_REQUIRED` `Tenant is required`.
 */
export class TenantRequiredError extends HttpError {
  constructor(entityName: string) {
    super(400, `${entityName} holds tenant data; run this for a tenant or tag the entity @tenancy shared`, { code: "TENANT_REQUIRED", responseMessage: "Tenant is required" });
    this.name = "TenantRequiredError";
  }
}

/** Puts `repository` at its model's place in `registry`: under its schema key, or at the top. */
function place(registry: RepositoryRegistry, model: EntityModel, repository: Repository): void {
  if (model.schemaKey) ((registry[model.schemaKey] ??= {}) as Record<string, Repository>)[model.repoKey] = repository;
  else registry[model.repoKey] = repository;
}

/** The models with repositories: every model but the link entities of N-N relations. */
const withRepositories = (models: readonly EntityModel[]) => models.filter((model) => !model.link);

const tenantRegistries = new WeakMap<RepositoryRegistry, WeakMap<DatabaseAdapter, RepositoryRegistry>>();

/**
 * The registry of a tenant: the models holding tenant data use `repositoriesFor(tenantAdapter)`, the shared models the
 * repositories of `root`, and `transaction` runs on the tenant's adapter. Built once per root and tenant adapter.
 */
export function tenantRepositories(root: RepositoryRegistry, tenantAdapter: DatabaseAdapter, models: readonly EntityModel[] = configuredModels()): RepositoryRegistry {
  let byAdapter = tenantRegistries.get(root);
  if (!byAdapter) {
    byAdapter = new WeakMap();
    tenantRegistries.set(root, byAdapter);
  }
  const cached = byAdapter.get(tenantAdapter);
  if (cached) return cached;
  const own = repositoriesFor(tenantAdapter);
  const registry: RepositoryRegistry = {};
  for (const model of withRepositories(models)) {
    const lookup = repositoryLookup(model);
    place(registry, model, lookup(model.tenancy === "tenant" ? own : root));
  }
  Object.defineProperty(registry, "transaction", { value: <T>(fn: () => Promise<T>) => publicTransaction(tenantAdapter, fn), enumerable: false });
  byAdapter.set(tenantAdapter, registry);
  return registry;
}

/**
 * The startup registry of a service with tenant entities: shared models keep their repositories, and each tenant
 * model's repository forwards to the current tenant scope's, throwing `TenantRequiredError` in the root scope.
 */
export function guardTenantRepositories(root: RepositoryRegistry, models: readonly EntityModel[]): RepositoryRegistry {
  const registry: RepositoryRegistry = {};
  for (const model of withRepositories(models)) {
    const lookup = repositoryLookup(model);
    const repository = lookup(root);
    if (model.tenancy !== "tenant") {
      place(registry, model, repository);
      continue;
    }
    const guarded: Record<string, unknown> = {};
    for (const key of Object.keys(repository)) {
      if (typeof (repository as unknown as Record<string, unknown>)[key] !== "function") continue;
      guarded[key] = (...args: unknown[]) => {
        const scope = currentDatabaseScope();
        if (scope.key === "root" || scope.repos === registry) throw new TenantRequiredError(model.entityName);
        return (lookup(scope.repos) as unknown as Record<string, (...args: unknown[]) => unknown>)[key]!(...args);
      };
    }
    place(registry, model, guarded as unknown as Repository);
  }
  Object.defineProperty(registry, "transaction", { value: (root as { transaction?: unknown }).transaction, enumerable: false });
  return registry;
}
