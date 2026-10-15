import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { toWhere } from "../sql/conditions.ts";
import { buildDrizzleSchema } from "../sql/schema.ts";
import { contractItem, contractModels, contractRecord, runAdapterContract } from "../testing/adapter-contract.ts";
import { entity, field } from "../testing/entities.ts";
import { resetPostgresTables } from "../testing/postgres.ts";
import { postgresAdapter, uniqueViolationField, type PostgresAdapter } from "./postgres.ts";

const url = process.env.TEST_POSTGRES_URL;

function adapterWithTables(): PostgresAdapter {
  const adapter = postgresAdapter({ url: url! });
  const connect = adapter.connect.bind(adapter);
  adapter.connect = async (models) => {
    await connect(models);
    await resetPostgresTables(adapter.client!, models);
  };
  return adapter;
}

if (url) {
  runAdapterContract("postgres", () => adapterWithTables());

  describe("postgres specifics", () => {
    const connected = async () => {
      const adapter = adapterWithTables();
      await adapter.connect(contractModels);
      return adapter;
    };

    test("duplicate unique values name the field", async () => {
      const adapter = await connected();
      await adapter.insert(contractItem, contractRecord({ title: "a", code: "x" }));
      await expect(adapter.insert(contractItem, contractRecord({ title: "b", code: "x" }))).rejects.toMatchObject({ field: "code" });
      await adapter.disconnect();
    });

    test("a throw inside a transaction rolls back", async () => {
      const adapter = await connected();
      await expect(
        adapter.transaction(async () => {
          await adapter.insert(contractItem, contractRecord({ title: "a" }));
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await adapter.count(contractItem, [])).toBe(0);
      await adapter.disconnect();
    });

    test("filter values are bound, never interpolated", async () => {
      const adapter = await connected();
      const injection = "'; DROP TABLE items; --";
      await adapter.insert(contractItem, contractRecord({ title: injection }));
      const found = await adapter.findOne(contractItem, [{ field: "title", op: "eq", value: injection }]);
      expect(found?.title).toBe(injection);
      const like = await adapter.count(contractItem, [{ field: "title", op: "contains", value: "DROP TABLE", caseInsensitive: true, literal: true }]);
      expect(like).toBe(1);
      expect(await adapter.count(contractItem, [])).toBe(1);
      await adapter.disconnect();
    });
  });
} else {
  test.skip("PostgreSQL adapter contract (set TEST_POSTGRES_URL to run)", () => {});
}

describe("ILIKE translation", () => {
  const user = entity("User", [field({ name: "name", type: "string" })]);
  const table = buildDrizzleSchema([user], "postgres").tables.User as Record<string, unknown>;
  const render = (op: "contains" | "startsWith", value: string) =>
    new PgDialect().sqlToQuery(toWhere(table, [{ field: "name", op, value, caseInsensitive: true, literal: true }], "postgres")!);

  test("contains escapes wildcards and binds the pattern", () => {
    expect(render("contains", "50%_\\")).toMatchObject({ sql: "\"users\".\"name\" ilike $1 escape '\\'", params: ["%50\\%\\_\\\\%"] });
  });
  test("startsWith anchors the pattern", () => {
    expect(render("startsWith", "ab").params).toEqual(["ab%"]);
  });
});

test("unique errors map from SQLSTATE 23505 through the index name", () => {
  const error = Object.assign(new Error('duplicate key value violates unique constraint "items_code_uq"'), {
    errno: "23505",
    constraint: "items_code_uq",
  });
  expect(uniqueViolationField(error, contractModels)).toBe("code");
  expect(uniqueViolationField(new Error("wrapped", { cause: error }), contractModels)).toBe("code");
  expect(uniqueViolationField(new Error("other"), contractModels)).toBeUndefined();
});
