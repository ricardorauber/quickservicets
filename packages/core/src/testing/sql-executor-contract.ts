import { describe, expect, test } from "bun:test";
import { UniqueViolationError } from "../adapter.ts";
import { postgresAdapter } from "../adapters/postgres.ts";
import type { SqlExecutor } from "../sql-executor.ts";
import { runAdapterContract, contractItem, contractModels, contractRecord } from "./adapter-contract.ts";
import { postgresDdl } from "./postgres.ts";

/** What `runSqlExecutorContract` accepts besides the factory. */
export interface SqlExecutorContractOptions {
  /** The name in the test titles (default: the executor's). */
  name?: string;
  /** The variable holding the PostgreSQL URL the executor connects to (default `TEST_POSTGRES_URL`). */
  variable?: string;
  /** The environment the variable is read from (default: the process's). */
  env?: Record<string, string | undefined>;
}

/** Drops and creates the tables of the models through an executor, as migrations do. */
async function resetTables(executor: SqlExecutor, models: typeof contractModels): Promise<void> {
  await executor.query("drop schema if exists public cascade", []);
  await executor.query("create schema public", []);
  // quickservicets-allow-unsafe: runs the DDL drizzle-kit generates from the models
  for (const statement of await postgresDdl(models)) await executor.query(statement, []);
}

/**
 * Registers `bun:test` tests every `SqlExecutor` must pass: the PostgreSQL adapter contract on
 * `postgresAdapter({ executor: create(url) })`, type round trips, transactions with rollback, unique violations and
 * abort signals. They run when the variable (default `TEST_POSTGRES_URL`) is set, and are one named skipped test
 * otherwise. The tests drop and recreate the `public` schema of that database.
 */
export function runSqlExecutorContract(create: (url: string) => SqlExecutor, options: SqlExecutorContractOptions = {}): void {
  const variable = options.variable ?? "TEST_POSTGRES_URL";
  const url = (options.env ?? process.env)[variable];
  const label = `${options.name ?? "sql"} executor contract`;
  if (!url) {
    test.skip(`${label}: set ${variable} to run it`, () => {});
    return;
  }

  runAdapterContract(label, async (models) => {
    const setup = create(url);
    try {
      await resetTables(setup, models);
    } finally {
      await setup.close();
    }
    return postgresAdapter({ executor: create(url) });
  });

  describe(label, () => {
    const withExecutor = async (work: (executor: SqlExecutor) => Promise<void>) => {
      const executor = create(url);
      try {
        await work(executor);
      } finally {
        await executor.close();
      }
    };

    test("declares a name and its capabilities", () =>
      withExecutor(async (executor) => {
        expect(typeof executor.name).toBe("string");
        for (const capability of ["interactiveTransactions", "listen", "preparedStatements"] as const) expect(typeof executor.capabilities[capability]).toBe("boolean");
      }));

    test("dates, JSON, UUIDs, numerics, arrays and nulls round-trip", () =>
      withExecutor(async (executor) => {
        const at = new Date("2026-01-02T03:04:05.678Z");
        const id = "0192f8a0-7b3c-7d4e-8f90-123456789abc";
        const [row] = await executor.query("select $1::timestamptz as at, $2::jsonb as doc, $3::uuid as id, $4::numeric as amount, array[$5::text, $6::text] as tags, $7::text as nothing, $8::int as count, $9::boolean as flag", [
          at,
          { a: [1, 2], b: { c: "d" } },
          id,
          "12.50",
          "x",
          "y",
          null,
          42,
          true,
        ]);
        expect(row!.at).toBeInstanceOf(Date);
        expect((row!.at as Date).toISOString()).toBe(at.toISOString());
        // JSON may come back parsed or as its text, which the adapter parses for JSON columns.
        expect(typeof row!.doc === "string" ? JSON.parse(row!.doc) : row!.doc).toEqual({ a: [1, 2], b: { c: "d" } });
        expect(row!.id).toBe(id);
        expect(String(row!.amount)).toBe("12.50");
        expect(row!.tags).toEqual(["x", "y"]);
        expect(row!.nothing).toBeNull();
        expect(row!.count).toBe(42);
        expect(row!.flag).toBe(true);
      }));

    test("a transaction commits when its function resolves and rolls back when it throws", () =>
      withExecutor(async (executor) => {
        await executor.query("drop table if exists qs_executor_contract", []);
        await executor.query("create table qs_executor_contract (id text primary key)", []);
        try {
          if (executor.capabilities.interactiveTransactions) {
            await executor.transaction(async (tx) => {
              await tx.query("insert into qs_executor_contract (id) values ($1)", ["kept"]);
            });
            await expect(
              executor.transaction(async (tx) => {
                await tx.query("insert into qs_executor_contract (id) values ($1)", ["dropped"]);
                throw new Error("roll back");
              }),
            ).rejects.toThrow("roll back");
            const rows = await executor.query("select id from qs_executor_contract order by id", []);
            expect(rows).toEqual([{ id: "kept" }]);
          }
        } finally {
          await executor.query("drop table qs_executor_contract", []);
        }
      }));

    test("a unique violation carries code 23505 and becomes a UniqueViolationError on the field", () =>
      withExecutor(async (executor) => {
        await executor.query("drop table if exists qs_executor_unique", []);
        await executor.query("create table qs_executor_unique (id text primary key, email text, constraint qs_executor_unique_email_uq unique (email))", []);
        try {
          await executor.query("insert into qs_executor_unique (id, email) values ($1, $2)", ["a", "x@example.com"]);
          const error = await executor.query("insert into qs_executor_unique (id, email) values ($1, $2)", ["b", "x@example.com"]).catch((caught: unknown) => caught);
          expect((error as { code?: unknown }).code).toBe("23505");
        } finally {
          await executor.query("drop table qs_executor_unique", []);
        }
        const setup = create(url);
        try {
          await resetTables(setup, contractModels);
        } finally {
          await setup.close();
        }
        const adapter = postgresAdapter({ executor: create(url) });
        await adapter.connect(contractModels);
        try {
          await adapter.insert(contractItem, contractRecord({ title: "One", code: "same" }));
          const error = await adapter.insert(contractItem, contractRecord({ title: "Two", code: "same" })).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(UniqueViolationError);
          expect((error as UniqueViolationError).field).toBe("code");
        } finally {
          await adapter.disconnect();
        }
      }));

    test("an aborted statement rejects with an AbortError, and one aborted before it is sent is never sent", () =>
      withExecutor(async (executor) => {
        const controller = new AbortController();
        const started = Date.now();
        const running = executor.query("select pg_sleep(2)", [], { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        const error = await running.catch((caught: unknown) => caught);
        expect((error as Error).name).toBe("AbortError");
        expect(Date.now() - started).toBeLessThan(1500);
        const aborted = AbortSignal.abort();
        const early = await executor.query("select 1", [], { signal: aborted }).catch((caught: unknown) => caught);
        expect((early as Error).name).toBe("AbortError");
      }));
  });
}
