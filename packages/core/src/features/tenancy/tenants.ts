import { HttpError, type DatabaseAdapter, type EntityModel, type Logger, type ResolvedConfig } from "../public.ts";
import { connectionResolver, type ConnectionOption } from "./connections.ts";
import { configDirectory, databaseDirectory, serviceDirectory, tenantInfoOf, type TenantDirectory, type TenantInfo } from "./directory.ts";
import { appliedTenantMigrations, migrateTenantDatabase, migrationFiles } from "./migrate.ts";
import { schemaNameOf } from "./scopes.ts";
import { stagingModels } from "./relay.ts";

/** The resolved options of the `tenancy` native that its commands and provisioning read. */
export interface TenancyOptions {
  source: "database" | "config" | "service";
  tenants: Record<string, Record<string, unknown>>;
  service?: string;
  strategy: StrategyOption;
  schema: string;
  connection?: ConnectionOption;
  connectionService?: string;
  connectionCache: { ttl: string };
}

/** What migrating and provisioning tenants need outside a request. */
export interface TenantOperations {
  options: TenancyOptions;
  directory: TenantDirectory;
  /** The `Tenant` model of the database source. */
  tenantModel?: EntityModel;
  /** Where a tenant's tables live: a schema view or its own connected adapter, closed with `close`. */
  open(tenant: TenantInfo): Promise<{ adapter: DatabaseAdapter; schema?: string; close(): Promise<void> }>;
  /** Applies the pending migrations to one tenant. */
  migrate(tenant: TenantInfo): Promise<string[]>;
  /** The number of migrations a tenant has not applied. */
  pending(tenant: TenantInfo): Promise<number>;
}

/** The tenancy options of a resolved config, or undefined when the native is not enabled. */
export function tenancyOptionsOf(config: ResolvedConfig): TenancyOptions | undefined {
  return config.features.find((feature) => feature.key === "tenancy")?.options as TenancyOptions | undefined;
}

/** The `tenancy.strategy` option: a strategy, or a function of the tenant choosing one. */
export type StrategyOption = "schema" | "database" | ((context: { tenant: TenantInfo }) => unknown);

/**
 * The strategy of each tenant: its own, else the option's, calling a function option once per tenant and keeping the
 * answer (it fails on an answer that is not a strategy).
 */
export function strategyResolver(option: StrategyOption): (tenant: TenantInfo) => Promise<"schema" | "database"> {
  const decided = new Map<string, Promise<"schema" | "database">>();
  return (tenant) => {
    if (tenant.strategy) return Promise.resolve(tenant.strategy);
    if (typeof option !== "function") return Promise.resolve(option);
    let found = decided.get(tenant.id);
    if (!found) {
      found = Promise.resolve(option({ tenant })).then((value) => {
        if (value !== "schema" && value !== "database") throw new Error(`Invalid tenancy.strategy for tenant ${tenant.id}: expected "schema" or "database"`);
        return value;
      });
      found.catch(() => decided.delete(tenant.id));
      decided.set(tenant.id, found);
    }
    return found;
  };
}

/** The strategy of a tenant without a function option: its own, else the configured one. */
export const strategyOf = (tenant: TenantInfo, options: TenancyOptions): "schema" | "database" =>
  tenant.strategy ?? (typeof options.strategy === "function" ? "schema" : options.strategy);

/**
 * The operations on tenants of a service: its directory, and migrating a tenant in its schema of `root` or in its own
 * database, opened from its connection for the time of the work.
 */
export function tenantOperations(input: { config: ResolvedConfig; models: readonly EntityModel[]; projectRoot: string; logger: Logger }): TenantOperations {
  const options = tenancyOptionsOf(input.config);
  if (!options) throw new Error("The tenancy native is not enabled; add tenancy: {} to quickservicets.config.ts");
  const root = input.config.database;
  const tenantModel = input.models.find((model) => model.key === "Tenant");
  const directory =
    options.source === "database"
      ? databaseDirectory(root, tenantModel ?? (() => { throw new Error('tenancy.source is "database" but the Tenant entity is missing; rebuild and run quickservicets migration add'); })())
      : options.source === "config"
        ? configDirectory(options.tenants)
        : serviceDirectory(options.service!);
  const tenantModels = input.models.filter((model) => model.tenancy === "tenant");
  // A tenant database of its own stages the queue and outbox rows of its transactions (when those natives run).
  const staging = stagingModels(input.models);
  const connections = connectionResolver({
    option: options.connection,
    ...(options.connectionService ? { service: options.connectionService } : {}),
    ttlMs: 0,
    logger: input.logger,
  });
  const strategy = strategyResolver(options.strategy);
  const open = async (tenant: TenantInfo) => {
    if ((await strategy(tenant)) === "schema") {
      if (!root.withSchema) throw new Error(`tenancy strategy "schema" needs an adapter with withSchema(); the ${root.kind ?? "configured"} adapter has none`);
      const schema = schemaNameOf(tenant, options.schema);
      return { adapter: root.withSchema(schema), schema, close: async () => {} };
    }
    if (!root.forConnection) throw new Error(`tenancy strategy "database" needs an adapter with forConnection(); the ${root.kind ?? "configured"} adapter has none`);
    const adapter = root.forConnection(await connections.resolve(tenant));
    await adapter.connect([...tenantModels, ...staging]);
    return { adapter, close: () => adapter.disconnect() };
  };
  return {
    options,
    directory,
    ...(tenantModel ? { tenantModel } : {}),
    open,
    async migrate(tenant) {
      const target = await open(tenant);
      try {
        return (await migrateTenantDatabase(input.projectRoot, { adapter: target.adapter, ...(target.schema ? { schema: target.schema } : { staging }), models: tenantModels })).applied;
      } finally {
        await target.close();
      }
    },
    async pending(tenant) {
      const target = await open(tenant);
      try {
        const applied = new Set(await appliedTenantMigrations({ adapter: target.adapter, ...(target.schema ? { schema: target.schema } : {}) }));
        return migrationFiles(input.projectRoot).filter((file) => !applied.has(file.id)).length;
      } finally {
        await target.close();
      }
    },
  };
}

/** The result of provisioning or migrating one tenant. */
export interface TenantProvisionResult {
  id: string;
  status: "active" | "suspended";
  /** The migrations applied to the tenant. */
  applied: string[];
}

/** Fails like the write commands of a source that is not the database. */
export function assertDatabaseSource(options: TenancyOptions, what: string): void {
  if (options.source !== "database") throw new HttpError(400, `${what} needs tenancy: { source: "database" }`);
}

/** The status of a tenant row, written through `write` so the cache of the service sees it. */
export type TenantWriter = {
  create(data: Record<string, unknown>): Promise<{ id: string }>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  findOne(where: unknown[]): Promise<{ id: string } | null>;
};

/**
 * Creates a tenant of the database source: inserts its row as suspended, migrates it, then makes it active. A failed
 * migration leaves the row suspended and rethrows the error with the tenant's row id.
 */
export async function provision(operations: TenantOperations, tenants: TenantWriter, input: Record<string, unknown> & { id: string }): Promise<TenantProvisionResult> {
  assertDatabaseSource(operations.options, "tenants create");
  const { id, ...rest } = input;
  if (await operations.directory.find(id)) throw new HttpError(409, `Tenant ${id} already exists`, { code: "TENANT_EXISTS" });
  const row = await tenants.create({ key: id, ...rest, status: "suspended" });
  const info = tenantInfoOf(id, { ...rest, status: "suspended" });
  const applied = await operations.migrate(info);
  await tenants.update(row.id, { status: "active" });
  return { id, status: "active", applied };
}
