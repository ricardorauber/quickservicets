import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateDrizzleJson, generateMigration, generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import type { EntityModel, OnDeleteAction } from "../model.ts";
import { entity, field } from "../testing/entities.ts";
import { buildDrizzleSchema, columnName } from "./schema.ts";

const organization = entity("Organization", [field({ name: "name", type: "string" })]);
const userWith = (onDelete: OnDeleteAction = "cascade") =>
  entity("User", [
    field({ name: "email", type: "string", unique: true }),
    field({ name: "age", type: "number", optional: true, index: true }),
    field({ name: "active", type: "boolean" }),
    field({ name: "birth", type: "date", optional: true }),
    field({ name: "role", type: "enum", values: ["admin", "member"] }),
    field({ name: "tags", type: "array", items: { type: "string" } }),
    field({ name: "address", type: "object", optional: true, fields: [{ name: "city", type: "string", optional: false }] }),
    field({ name: "passwordHash", type: "string", hidden: true }),
    field({ name: "organization", type: "ref", target: "Organization", onDelete, optional: true }),
  ]);

async function sqliteSql(models: EntityModel[]): Promise<string> {
  const schema = buildDrizzleSchema(models, "sqlite");
  return (await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema.tables))).join("\n");
}

async function postgresSql(models: EntityModel[]): Promise<string> {
  const schema = buildDrizzleSchema(models, "postgres");
  return (await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema.tables))).join("\n");
}

test("column names are snake_case", () => {
  expect(columnName("passwordHash")).toBe("password_hash");
  expect(columnName("email")).toBe("email");
});

describe("type mapping", () => {
  test("sqlite", async () => {
    const sql = await sqliteSql([organization, userWith()]);
    for (const column of [
      "`email` text NOT NULL",
      "`age` real",
      "`active` integer NOT NULL",
      "`birth` integer",
      "`role` text NOT NULL",
      "`tags` text NOT NULL",
      "`address` text",
      "`password_hash` text NOT NULL",
      "`organization` text",
    ]) {
      expect(sql).toContain(column);
    }
  });
  test("postgres", async () => {
    const sql = await postgresSql([organization, userWith()]);
    for (const column of [
      '"email" text NOT NULL',
      '"age" double precision',
      '"active" boolean NOT NULL',
      '"birth" timestamp with time zone',
      '"role" text NOT NULL',
      '"tags" jsonb NOT NULL',
      '"address" jsonb',
      '"password_hash" text NOT NULL',
      '"organization" text',
    ]) {
      expect(sql).toContain(column);
    }
  });
});

test.each([
  ["sqlite", sqliteSql, ["`id` text PRIMARY KEY NOT NULL", "`created_at` integer NOT NULL", "`updated_at` integer NOT NULL", "`users_created_at_idx`"]],
  ["postgres", postgresSql, ['"id" text PRIMARY KEY NOT NULL', '"created_at" timestamp with time zone NOT NULL', '"updated_at" timestamp with time zone NOT NULL', '"users_created_at_idx"']],
] as const)("%s system columns and created_at index", async (_, generate, expected) => {
  const sql = await generate([organization, userWith()]);
  for (const fragment of expected) expect(sql).toContain(fragment);
});

test("nullability follows optional", async () => {
  const sql = await sqliteSql([organization, userWith()]);
  expect(sql).toMatch(/`age` real,/);
  expect(sql).toContain("`email` text NOT NULL");
});

test("unique and regular index names", async () => {
  const sql = await postgresSql([organization, userWith()]);
  expect(sql).toContain('CREATE UNIQUE INDEX "users_email_uq"');
  expect(sql).toContain('CREATE INDEX "users_age_idx"');
});

test.each([
  ["cascade", "ON DELETE cascade"],
  ["restrict", "ON DELETE restrict"],
  ["setNull", "ON DELETE set null"],
] as const)("foreign key action for %s", async (onDelete, expected) => {
  expect(await sqliteSql([organization, userWith(onDelete)])).toContain(expected);
  expect(await postgresSql([organization, userWith(onDelete)])).toContain(expected);
});

test("enum check constraint rejects other values in SQLite", async () => {
  const database = new Database(":memory:");
  for (const statement of (await sqliteSql([organization, userWith()])).split(/;\s*\n|--> statement-breakpoint/)) {
    if (statement.trim()) database.run(statement);
  }
  const insert = (role: string) =>
    database.run(
      "insert into users (id, created_at, updated_at, email, active, role, tags, password_hash) values (?, 0, 0, ?, 1, ?, '[]', 'x')",
      [crypto.randomUUID(), `${role}@x.co`, role],
    );
  expect(() => insert("admin")).not.toThrow();
  expect(() => insert("root")).toThrow(/CHECK constraint failed/);
});

test("self references resolve lazily", async () => {
  const category = entity("Category", [
    field({ name: "parent", type: "ref", target: "Category", onDelete: "cascade", optional: true }),
  ]);
  expect(await sqliteSql([category])).toContain("REFERENCES `categorys`(`id`)");
});
