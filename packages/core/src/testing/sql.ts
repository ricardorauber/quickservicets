import type { Database } from "bun:sqlite";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import type { EntityModel } from "../model.ts";
import { buildDrizzleSchema } from "../sql/schema.ts";

/** DDL statements that create the tables of `models` on an empty SQLite database. */
export async function sqliteDdl(models: EntityModel[]): Promise<string[]> {
  const schema = buildDrizzleSchema(models, "sqlite");
  return generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson({ ...schema.tables, ...schema.junctions }));
}

/** Creates the tables of `models` directly, for tests that do not run migrations. */
export async function createSqliteTables(client: Database, models: EntityModel[]): Promise<void> {
  for (const statement of await sqliteDdl(models)) client.run(statement);
}
