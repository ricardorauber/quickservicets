import type { Repositories } from "./hooks.ts";

/** What a migration's `up` and `down` functions receive. */
export interface MigrationContext {
  /** Runs SQL on the migration connection: `ctx.sql("...")` or as a tagged template with bound values. */
  sql(query: TemplateStringsArray | string, ...values: unknown[]): Promise<unknown>;
  /** The Drizzle database instance of the migration connection. */
  db: unknown;
  /** Repositories of the current model; they reflect the latest model, not the model at that migration. */
  repos: Repositories;
}
