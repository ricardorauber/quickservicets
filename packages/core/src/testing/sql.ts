import type { Database } from "bun:sqlite";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import type { EntityModel } from "../model.ts";
import { buildDrizzleSchema, type DrizzleSchemaOptions } from "../sql/schema.ts";

/** DDL statements that create the tables of `models` on an empty SQLite database. */
export async function sqliteDdl(models: EntityModel[], options: DrizzleSchemaOptions = {}): Promise<string[]> {
  const schema = buildDrizzleSchema(models, "sqlite", options);
  return generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson({ ...schema.tables, ...schema.junctions }));
}

/** Creates the tables of `models` directly, for tests that do not run migrations. */
export async function createSqliteTables(client: Database, models: EntityModel[], options: DrizzleSchemaOptions = {}): Promise<void> {
  for (const statement of await sqliteDdl(models, options)) client.run(statement);
}
