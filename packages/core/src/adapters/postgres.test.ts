import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { PgDialect } from "drizzle-orm/pg-core";
import { toWhere } from "../sql/conditions.ts";
import { buildDrizzleSchema } from "../sql/schema.ts";
import { contractItem, contractModels, contractOrganization, contractRecord, runAdapterContract } from "../testing/adapter-contract.ts";
import { entity, field } from "../testing/entities.ts";
import type { StoredRecord } from "../adapter.ts";
import { HttpError } from "../errors.ts";
import { createRepositories, type Repository } from "../repository.ts";
import { postgresDdl, recordStatements, resetPostgresTables } from "../testing/postgres.ts";
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

    test("wildcards and quotes in filter values match literally and stay out of the SQL text", async () => {
      const adapter = await connected();
      for (const title of ["50%_off 'today'", "50 percent off", "500_off 'today'", "50%xoff 'today'"]) await adapter.insert(contractItem, contractRecord({ title }));
      const log = recordStatements(adapter.client!);
      const text = (op: "contains" | "startsWith", value: string) => [{ field: "title", op, value, caseInsensitive: true as const, literal: true as const }];
      const titles = async (op: "contains" | "startsWith", value: string) =>
        (await adapter.findMany(contractItem, { where: text(op, value), sort: [{ field: "title", direction: "asc" }], limit: 10, offset: 0 })).data.map((record) => record.title);
      expect(await titles("contains", "%_OFF '")).toEqual(["50%_off 'today'"]);
      expect(await titles("startsWith", "50%")).toEqual(["50%_off 'today'", "50%xoff 'today'"]);
      expect(await adapter.count(contractItem, text("contains", "'today'"))).toBe(3);
      expect(log.statements.length).toBeGreaterThan(0);
      for (const statement of log.statements) expect(statement).not.toMatch(/%|today|OFF/);
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

  describe("precompiled single-row statements", () => {
    test("every field type round-trips through insert, read and update as the query builder reads it", async () => {
      const adapter = adapterWithTables();
      await adapter.connect(contractModels);
      const organization = await adapter.insert(contractOrganization, contractRecord({ name: "Acme" }));
      const values = {
        title: "Full",
        code: "A-1",
        score: 4.25,
        active: false,
        publishedAt: new Date("2026-02-03T04:05:06.789Z"),
        status: "published",
        organization: organization.id,
        partners: [organization.id],
        tags: ["a", "b"],
        meta: { views: 3, lines: [{ qty: 1 }], startsAt: new Date("2026-03-01T09:30:00Z"), reminders: [] },
      };
      const inserted = await adapter.insert(contractItem, contractRecord(values));
      // Drizzle's query builder shows how records were read before.
      const table = buildDrizzleSchema(contractModels, "postgres").tables.Item as never as Record<string, never> & { id: never };
      const builder = drizzle({ client: adapter.client! });
      const viaBuilder = async (): Promise<StoredRecord> => {
        const rows = (await builder.select().from(table as never).where(eq(table.id, inserted.id))) as unknown as StoredRecord[];
        return { ...rows[0]!, partners: (await adapter.findById(contractItem, inserted.id))!.partners };
      };
      expect(await adapter.findById(contractItem, inserted.id)).toEqual((await viaBuilder())!);
      expect(inserted).toEqual((await viaBuilder())!);
      expect(inserted.meta).toEqual({ ...values.meta, startsAt: "2026-03-01T09:30:00.000Z" });
      const updated = await adapter.updateById(contractItem, inserted.id, { score: -1.5, active: true, publishedAt: null, tags: [], meta: null, status: "draft" });
      expect(updated).toEqual((await viaBuilder())!);
      expect(updated).toMatchObject({ score: -1.5, active: true, publishedAt: null, tags: [], meta: null, status: "draft" });
      expect(await adapter.findById(contractItem, inserted.id)).toEqual(updated!);
      await adapter.disconnect();
    });

    test("explicit and default schemas", async () => {
      const invoice = entity("Invoice", [field({ name: "total", type: "number" }), field({ name: "owners", type: "refArray", target: "Customer", onDelete: "pull", optional: true })], {
        key: "billing/Invoice",
        schema: "billing",
        schemaKey: "billing",
      });
      const customer = entity("Customer", [field({ name: "name", type: "string" })]);
      const models = [customer, invoice];
      const admin = new SQL(url!);
      await admin.unsafe("drop schema if exists billing cascade; drop schema if exists tenant_x cascade; create schema billing; create schema tenant_x");
      const ddl = await postgresDdl(models);
      await admin.begin(async (tx) => {
        await tx.unsafe("set local search_path to tenant_x");
        for (const statement of ddl) await tx.unsafe(statement.replaceAll('"public".', ""));
      });
      const adapter = postgresAdapter({ url: url! });
      await adapter.connect(models, { defaultSchema: "tenant-x" });
      const repos = createRepositories(models, adapter);
      const buyer = await (repos.customers as Repository).create({ name: "Ann" });
      const invoices = (repos.billing as Record<string, Repository>).invoices!;
      const bill = await invoices.create({ total: 10, owners: [buyer.id] });
      expect(await invoices.update(bill.id, { total: 12 })).toMatchObject({ total: 12, owners: [buyer.id] });
      await (repos.customers as Repository).delete(buyer.id);
      expect(await invoices.findById(bill.id)).toMatchObject({ total: 12, owners: [] });
      await invoices.delete(bill.id);
      const counts = (await admin.unsafe("select (select count(*) from tenant_x.customers)::int as customers, (select count(*) from billing.invoices)::int as invoices")) as { customers: number; invoices: number }[];
      expect(counts[0]).toEqual({ customers: 0, invoices: 0 });
      await adapter.disconnect();
      await admin.unsafe("drop schema billing cascade; drop schema tenant_x cascade");
      await admin.close();
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

    test("deleting a record pulled from reference arrays runs one read and one statement", async () => {
      const { adapter, log, members, teams } = await connected();
      const loner = await members.create({ email: "a@x.co" });
      const [first, member, last] = await Promise.all(["b", "c", "d"].map((name) => members.create({ email: `${name}@x.co` })));
      const team = await teams.create({ name: "T", members: [first!.id, member!.id, last!.id] });
      log.clear();
      await members.delete(loner.id);
      expect(log.statements).toHaveLength(2);
      log.clear();
      await members.delete(member!.id);
      expect(log.statements).toHaveLength(2);
      expect(log.statements.some((statement) => statement.startsWith("insert"))).toBe(false);
      const after = (await teams.findById(team.id))!;
      expect(after.members).toEqual([first!.id, last!.id]);
      expect(after.updatedAt.getTime()).toBeGreaterThan(team.updatedAt.getTime());
      await adapter.disconnect();
    });

    test("a page and its count are sent together, and a page without the total is one statement", async () => {
      const { adapter, log, members } = await connected();
      for (const name of ["a", "b", "c"]) await members.create({ email: `${name}@x.co` });
      log.clear();
      const query = { where: [], sort: [{ field: "email", direction: "asc" as const }], limit: 2, offset: 0 };
      const pending = adapter.findMany(member, query);
      // Only microtasks run here: a count sent after the page's result would need a network round trip first.
      for (let turn = 0; turn < 50; turn++) await null;
      expect(log.statements).toHaveLength(2);
      const result = await pending;
      expect(result.total).toBe(3);
      expect(result.data.map((record) => record.email)).toEqual(["a@x.co", "b@x.co"]);
      log.clear();
      expect((await adapter.findMany(member, { ...query, withTotal: false })).data).toHaveLength(2);
      expect(log.statements).toHaveLength(1);
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
