import {
  DEFAULT_DATABASE,
  jsonLogger,
  loadConfig,
  tenantOperations,
  type TenantInfo,
  type ResolvedConfig,
  storageConfigured,
} from "@quickservicets/core";
import { databaseTenancyOf, parseProjectEntities as parseEntities } from "../entities/parse-entities.ts";
import { BuildError } from "../errors.ts";
import { listMigrations } from "./snapshot.ts";
import { applyMigrations, withSourceDrivers, type AppliedMigration, type DatabaseDriver, type MigrateOptions, type MigrateResult, type MigrationDriver, type MigrationFile, type MigrationModule, type MigrationSource } from "@quickservicets/core";

export { HISTORY_TABLE, MigrationError, MONGO_HISTORY_COLLECTION, MONGO_NO_TRANSACTION_WARNING, schemaHistoryTable, splitSqlOptions } from "@quickservicets/core";
export type { AppliedMigration, MigrateOptions, MigrateResult } from "@quickservicets/core";

/** The project's config, models and migration files, as `quickservicets migrate` reads them. */
export async function projectMigrationSource(projectRoot: string): Promise<MigrationSource> {
  const config = await loadConfig(projectRoot);
  const models = parseEntities(projectRoot, config.features, { storage: storageConfigured(config), databases: Object.keys(config.databases), databaseTenancy: databaseTenancyOf(config) });
  return { config, models, files: (database) => listMigrations(projectRoot, database), load: async (file) => (await import(file.file)) as MigrationModule };
}

/**
 * Connects the configured databases and runs `work` with one driver per database that keeps a schema, default first
 * then by name (only `database` when given); memory databases are left out.
 */
async function withDrivers<T>(projectRoot: string, work: (drivers: DatabaseDriver[], config: ResolvedConfig, named: boolean) => Promise<T>, database?: string): Promise<T> {
  return withSourceDrivers(await projectMigrationSource(projectRoot), work, database);
}

async function withDriver<T>(projectRoot: string, work: (driver: MigrationDriver, config: ResolvedConfig) => Promise<T>): Promise<T> {
  return withDrivers(projectRoot, (drivers, config) => work(drivers[0]!.driver, config), DEFAULT_DATABASE);
}

/** Reads the applied migrations of the configured database without changing it. */
export function readAppliedMigrations(projectRoot: string): Promise<AppliedMigration[]> {
  return withDriver(projectRoot, (driver) => driver.readHistory());
}

export interface MigrationHistory {
  applied: AppliedMigration[];
  /** Per explicit schema, the default schemas that applied each migration there. */
  schemas: Map<string, Map<string, string[]>>;
}

/** The migration history of one database. */
export interface DatabaseMigrationHistory extends MigrationHistory {
  database: string;
  files: MigrationFile[];
}

/** Reads the history of every database that keeps a schema, with the histories of the given explicit schemas. */
export function readDatabaseHistories(projectRoot: string, schemas: (database: string) => string[]): Promise<DatabaseMigrationHistory[]> {
  return withDrivers(projectRoot, async (drivers) => {
    const histories: DatabaseMigrationHistory[] = [];
    for (const { database, driver, files } of drivers) {
      const records = new Map<string, Map<string, string[]>>();
      for (const schema of schemas(database)) records.set(schema, await driver.readSchemaHistory(schema));
      histories.push({ database, files, applied: await driver.readHistory(), schemas: records });
    }
    return histories;
  });
}

/** Reads the default schema's history and the histories of the given explicit schemas without changing them. */
export function readMigrationHistory(projectRoot: string, schemas: string[]): Promise<MigrationHistory> {
  return withDriver(projectRoot, async (driver) => {
    const records = new Map<string, Map<string, string[]>>();
    for (const schema of schemas) records.set(schema, await driver.readSchemaHistory(schema));
    return { applied: await driver.readHistory(), schemas: records };
  });
}

/** `quickservicets migrate [target] [--force] [--database <name>]` */
export async function migrate(projectRoot: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  return applyMigrations(await projectMigrationSource(projectRoot), options);
}

export interface TenantMigrateOptions {
  /** One tenant to migrate. */
  tenant?: string;
  /** Migrate the service's database, then every tenant. */
  allTenants?: boolean;
  /** Tenants migrated at once (default 4). */
  concurrency?: number;
  /** Keep migrating the other tenants after one fails. */
  continueOnError?: boolean;
}

export interface TenantMigrateResult {
  messages: string[];
  /** The tenants whose migration failed. */
  failed: string[];
}

/**
 * `quickservicets migrate --tenant <id>` and `--all-tenants`: applies the tenant statements of every pending migration
 * in each tenant's schema or database, with the history kept next to its tables.
 */
export async function migrateTenants(projectRoot: string, options: TenantMigrateOptions): Promise<TenantMigrateResult> {
  const messages: string[] = [];
  if (options.allTenants) messages.push(...(await migrate(projectRoot)).messages);
  const config = await loadConfig(projectRoot);
  if (!config.features.some((feature) => feature.key === "tenancy")) throw new BuildError("migrate --tenant and --all-tenants need tenancy: {} in quickservicets.config.ts");
  const models = parseEntities(projectRoot, config.features, { storage: storageConfigured(config), databases: Object.keys(config.databases), databaseTenancy: databaseTenancyOf(config) });
  await config.database.connect(models, { defaultSchema: config.schema });
  const failed: string[] = [];
  try {
    const operations = tenantOperations({ config, models, projectRoot, logger: config.logger ?? jsonLogger });
    const migrateOne = async (tenant: TenantInfo) => {
      const applied = await operations.migrate(tenant);
      if (applied.length === 0) messages.push(`${tenant.id}: Up to date`);
      // With named databases each applied migration names its database: `acme: orders: Applied <id>`.
      for (const id of applied) {
        const [database, own] = id.includes(": ") ? id.split(": ") : [undefined, id];
        messages.push(database ? `${tenant.id}: ${database}: Applied ${own}` : `${tenant.id}: Applied ${id}`);
      }
    };
    if (options.tenant !== undefined) {
      const tenant = await operations.directory.find(options.tenant);
      if (!tenant) throw new BuildError(`Unknown tenant ${options.tenant}`);
      await migrateOne(tenant);
      return { messages, failed };
    }
    const tenants: TenantInfo[] = [];
    for await (const tenant of operations.directory.list()) tenants.push(tenant);
    let next = 0;
    let stopped = false;
    let migrated = 0;
    const worker = async () => {
      while (!stopped && next < tenants.length) {
        const tenant = tenants[next++]!;
        try {
          await migrateOne(tenant);
          migrated++;
        } catch (error) {
          failed.push(tenant.id);
          messages.push(`${tenant.id}: Failed: ${(error as Error)?.message ?? String(error)}`);
          if (!options.continueOnError) stopped = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
    messages.push(`Migrated ${migrated} tenants, ${failed.length} failed`);
    return { messages, failed };
  } finally {
    await config.database.disconnect();
  }
}
