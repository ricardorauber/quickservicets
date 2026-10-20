import type { SQL } from "bun";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import type { EntityModel } from "../model.ts";
import { buildDrizzleSchema } from "../sql/schema.ts";

/** DDL statements that create the tables of `models` on an empty PostgreSQL schema. */
export async function postgresDdl(models: EntityModel[]): Promise<string[]> {
  const schema = buildDrizzleSchema(models, "postgres");
  return generateMigration(generateDrizzleJson({}), generateDrizzleJson({ ...schema.tables, ...schema.junctions }));
}

/** Drops everything in the public schema and creates the tables of `models`, for tests that skip migrations. */
export async function resetPostgresTables(client: SQL, models: EntityModel[]): Promise<void> {
  await client.unsafe("drop schema if exists public cascade; create schema public;");
  for (const statement of await postgresDdl(models)) await client.unsafe(statement);
}

export interface StatementLog {
  /** The statements sent so far, `begin` and `commit`/`rollback` included. */
  readonly statements: string[];
  clear(): void;
}

/** Records every statement a Bun.sql client sends, including those inside its transactions, to count round trips. */
export function recordStatements(client: SQL): StatementLog {
  const statements: string[] = [];
  const track = (target: SQL) => {
    const unsafe = target.unsafe.bind(target);
    target.unsafe = ((query: string, params?: unknown[]) => {
      statements.push(query);
      return unsafe(query, params);
    }) as SQL["unsafe"];
  };
  track(client);
  const begin = client.begin.bind(client) as (fn: (tx: SQL) => Promise<unknown>) => Promise<unknown>;
  client.begin = (async (fn: (tx: SQL) => Promise<unknown>) => {
    statements.push("begin");
    try {
      const result = await begin(async (tx) => {
        track(tx);
        return fn(tx);
      });
      statements.push("commit");
      return result;
    } catch (error) {
      statements.push("rollback");
      throw error;
    }
  }) as SQL["begin"];
  return {
    statements,
    clear: () => void statements.splice(0),
  };
}
