import type { Database } from "bun:sqlite";
import type { EntityModel } from "../model.ts";
import { buildDrizzleSchema, type DrizzleSchemaOptions } from "../sql/schema.ts";

/** DDL statements that create the tables of `models` on an empty SQLite database. */
export async function sqliteDdl(models: EntityModel[], options: DrizzleSchemaOptions = {}): Promise<string[]> {
  const schema = buildDrizzleSchema(models, "sqlite", options);
  // Loaded on first use through a computed name, so a service bundle whose config imports the testing helpers leaves
  // the migration generator (and the optional drivers it imports) out.
  const generator = ["drizzle-kit", "api"].join("/");
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = (await import(generator)) as typeof import("drizzle-kit/api");
  return generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson({ ...schema.tables, ...schema.junctions }));
}

/** Creates the tables of `models` directly, for tests that do not run migrations. */
export async function createSqliteTables(client: Database, models: EntityModel[], options: DrizzleSchemaOptions = {}): Promise<void> {
  for (const statement of await sqliteDdl(models, options)) client.run(statement);
}
