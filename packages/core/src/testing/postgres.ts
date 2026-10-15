import type { SQL } from "bun";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import type { EntityModel } from "../model.ts";
import { buildDrizzleSchema } from "../sql/schema.ts";

/** DDL statements that create the tables of `models` on an empty PostgreSQL schema. */
export async function postgresDdl(models: EntityModel[]): Promise<string[]> {
  return generateMigration(generateDrizzleJson({}), generateDrizzleJson(buildDrizzleSchema(models, "postgres").tables));
}

/** Drops everything in the public schema and creates the tables of `models`, for tests that skip migrations. */
export async function resetPostgresTables(client: SQL, models: EntityModel[]): Promise<void> {
  await client.unsafe("drop schema if exists public cascade; create schema public;");
  for (const statement of await postgresDdl(models)) await client.unsafe(statement);
}
