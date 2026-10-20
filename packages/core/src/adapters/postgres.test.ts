import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { toWhere } from "../sql/conditions.ts";
import { buildDrizzleSchema } from "../sql/schema.ts";
import { contractItem, contractModels, contractRecord, runAdapterContract } from "../testing/adapter-contract.ts";
import { entity, field } from "../testing/entities.ts";
import { HttpError } from "../errors.ts";
import { createRepositories, type Repository } from "../repository.ts";
import { recordStatements, resetPostgresTables } from "../testing/postgres.ts";
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

  describe("statements per write", () => {
    const member = entity("Member", [
      field({ name: "email", type: "string", unique: true }),
      field({ name: "name", type: "string", optional: true }),
    ]);
    const team = entity("Team", [
      field({ name: "name", type: "string" }),
      field({ name: "members", type: "refArray", target: "Member", onDelete: "pull", optional: true }),
    ]);
    const models = [member, team];
    const connected = async () => {
      const adapter = adapterWithTables();
      await adapter.connect(models);
      const log = recordStatements(adapter.client!);
      const repos = createRepositories(models, adapter);
      return { adapter, log, members: repos.members as Repository, teams: repos.teams as Repository };
    };
    const conflict = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(HttpError);
      return error as HttpError;
    };

    test("only writes of an entity with reference arrays open a transaction", async () => {
      const { adapter, log } = await connected();
      const at = new Date();
      const plain = await adapter.insert(member, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, email: "a@x.co" });
      await adapter.updateById(member, plain.id, { name: "A" });
      expect(log.statements).not.toContain("begin");
      log.clear();
      const withArray = await adapter.insert(team, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, name: "T", members: [plain.id] });
      expect(log.statements[0]).toBe("begin");
      expect(log.statements.at(-1)).toBe("commit");
      log.clear();
      await adapter.updateById(team, withArray.id, { members: [] });
      expect(log.statements[0]).toBe("begin");
      expect(log.statements.at(-1)).toBe("commit");
      await adapter.disconnect();
    });

    test("create, update and replace run one statement each", async () => {
      const { adapter, log, members } = await connected();
      const created = await members.create({ email: "a@x.co" });
      expect(log.statements).toHaveLength(1);
      expect(log.statements[0]).toStartWith("insert into");
      log.clear();
      // An update in the same millisecond as the stored `updatedAt` reads the record first, to keep it increasing.
      await Bun.sleep(2);
      const updated = await members.update(created.id, { name: "Ann" });
      expect(updated).toMatchObject({ id: created.id, email: "a@x.co", name: "Ann" });
      expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
      expect(log.statements).toHaveLength(1);
      expect(log.statements[0]).toStartWith("update");
      log.clear();
      await Bun.sleep(2);
      await members.replace(created.id, { email: "b@x.co" });
      expect(log.statements).toHaveLength(1);
      expect(await members.findById(created.id)).toMatchObject({ email: "b@x.co", name: null });
      await adapter.disconnect();
    });

    test("unique violations map to 409 without a transaction", async () => {
      const { adapter, log, members } = await connected();
      await members.create({ email: "a@x.co" });
      const second = await members.create({ email: "b@x.co" });
      log.clear();
      for (const attempt of [() => members.create({ email: "a@x.co" }), () => members.update(second.id, { email: "a@x.co" })]) {
        const error = await conflict(attempt());
        expect(error.status).toBe(409);
        expect(error.message).toBe("Value already exists");
        expect(error.details).toEqual([{ field: "email", message: "Value already exists" }]);
      }
      expect(log.statements).not.toContain("begin");
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
