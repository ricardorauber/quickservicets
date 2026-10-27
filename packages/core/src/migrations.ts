import type { Db, MongoClient } from "mongodb";
import type { Repositories } from "./hooks.ts";

/** Options of a migration statement. */
export interface MigrationSqlOptions {
  /** The explicit schema whose table the statement changes. */
  schema?: string;
  /**
   * Set (with the `tenancy` native) on statements that change a table every tenant shares: they run only in the
   * service's own database, while the statements without a marker run in each tenant's schema or database.
   */
  shared?: true;
}

/** What a migration's `up` and `down` functions receive. */
export interface MigrationContext {
  /** Runs SQL on the migration connection: `ctx.sql("...")` or as a tagged template with bound values. */
  sql(query: TemplateStringsArray | string, ...values: unknown[]): Promise<unknown>;
  /**
   * Runs a statement that changes a table of an explicit schema. Every tenant shares that schema, so the statement
   * runs only when no tenant has applied the migration there yet.
   */
  sql(query: string, options: MigrationSqlOptions): Promise<unknown>;
  /** The Drizzle database instance of the migration connection. */
  db: unknown;
  /** Repositories of the current model; they reflect the latest model, not the model at that migration. */
  repos: Repositories;
}

/** What a MongoDB migration's `up` and `down` functions receive. */
export interface MongoMigrationContext {
  /** The native database of a schema, or of the default schema when omitted. */
  db(schema?: string): Db;
  client: MongoClient;
  /** Repositories of the current model; they reflect the latest model, not the model at that migration. */
  repos: Repositories;
}
