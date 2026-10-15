import { describe, expect, test } from "bun:test";
import { contractItem, contractModels, contractRecord, runAdapterContract } from "../testing/adapter-contract.ts";
import { createSqliteTables } from "../testing/sql.ts";
import { toWhere } from "../sql/conditions.ts";
import { buildDrizzleSchema } from "../sql/schema.ts";
import { entity, field } from "../testing/entities.ts";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { sqliteAdapter, uniqueViolationField, type SqliteAdapter } from "./sqlite.ts";
import { UniqueViolationError } from "../adapter.ts";

function adapterWithTables(): SqliteAdapter {
  const adapter = sqliteAdapter({ path: ":memory:" });
  const connect = adapter.connect.bind(adapter);
  adapter.connect = async (models) => {
    await connect(models);
    await createSqliteTables(adapter.client!, models);
  };
  return adapter;
}

runAdapterContract("sqlite", () => adapterWithTables());

const connected = async () => {
  const adapter = adapterWithTables();
  await adapter.connect(contractModels);
  return adapter;
};

describe("condition translation", () => {
  const user = entity("User", [
    field({ name: "name", type: "string" }),
    field({ name: "age", type: "number", optional: true }),
  ]);
  const table = buildDrizzleSchema([user], "sqlite").tables.User as Record<string, unknown>;
  const render = (where: Parameters<typeof toWhere>[1]) => new SQLiteSyncDialect().sqlToQuery(toWhere(table, where, "sqlite")!);

  test.each([
    ["eq", [{ field: "age", op: "eq", value: 1 }], '"users"."age" = ?', [1]],
    ["ne", [{ field: "age", op: "ne", value: 1 }], '"users"."age" <> ?', [1]],
    ["in", [{ field: "age", op: "in", value: [1, 2] }], '"users"."age" in (?, ?)', [1, 2]],
    ["nin", [{ field: "age", op: "nin", value: [1] }], '"users"."age" not in (?)', [1]],
    ["gt", [{ field: "age", op: "gt", value: 1 }], '"users"."age" > ?', [1]],
    ["gte", [{ field: "age", op: "gte", value: 1 }], '"users"."age" >= ?', [1]],
    ["lt", [{ field: "age", op: "lt", value: 1 }], '"users"."age" < ?', [1]],
    ["lte", [{ field: "age", op: "lte", value: 1 }], '"users"."age" <= ?', [1]],
    ["contains", [{ field: "name", op: "contains", value: "a%b_c\\" }], "lower(\"users\".\"name\") like lower(?) escape '\\'", ["%a\\%b\\_c\\\\%"]],
    ["startsWith", [{ field: "name", op: "startsWith", value: "ab" }], "lower(\"users\".\"name\") like lower(?) escape '\\'", ["ab%"]],
    ["exists", [{ field: "age", op: "exists", value: true }], '"users"."age" is not null', []],
    ["isNull", [{ field: "age", op: "isNull", value: true }], '"users"."age" is null', []],
  ] as const)("%s", (_, where, sql, params) => {
    const query = render(where as never);
    expect(query.sql).toBe(sql);
    expect(query.params).toEqual(params as unknown as unknown[]);
  });
});

test("LIKE wildcards in values are matched literally", async () => {
  const adapter = await connected();
  for (const title of ["50% off", "500"]) await adapter.insert(contractItem, contractRecord({ title }));
  const found = await adapter.findMany(contractItem, {
    where: [{ field: "title", op: "contains", value: "50%", caseInsensitive: true, literal: true }],
    sort: [{ field: "title", direction: "asc" }],
    limit: 10,
    offset: 0,
  });
  expect(found.data.map((record) => record.title)).toEqual(["50% off"]);
});

test("unique errors map to the field name", async () => {
  const adapter = await connected();
  await adapter.insert(contractItem, contractRecord({ title: "a", code: "x" }));
  await expect(adapter.insert(contractItem, contractRecord({ title: "b", code: "x" }))).rejects.toMatchObject({ field: "code" });
  expect(uniqueViolationField(new Error("UNIQUE constraint failed: items.code"), contractModels)).toBe("code");
  expect(uniqueViolationField(new Error("other"), contractModels)).toBeUndefined();
  expect(new UniqueViolationError("code").field).toBe("code");
});

test("a throw inside a transaction rolls everything back", async () => {
  const adapter = await connected();
  await expect(
    adapter.transaction(async () => {
      await adapter.insert(contractItem, contractRecord({ title: "a" }));
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  expect(await adapter.count(contractItem, [])).toBe(0);
});

test("operations outside a transaction wait for it", async () => {
  const adapter = await connected();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = adapter.transaction(async () => {
    await adapter.insert(contractItem, contractRecord({ title: "inside" }));
    await gate;
    throw new Error("abort");
  });
  const outside = adapter.insert(contractItem, contractRecord({ title: "outside" }));
  release();
  await expect(transaction).rejects.toThrow("abort");
  await outside;
  const titles = (await adapter.findMany(contractItem, { where: [], sort: [{ field: "title", direction: "asc" }], limit: 10, offset: 0 })).data.map((r) => r.title);
  expect(titles).toEqual(["outside"]);
});

test("foreign keys are enabled on connect", async () => {
  const adapter = await connected();
  expect(adapter.client!.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
});
