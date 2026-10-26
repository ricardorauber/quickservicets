import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { createLinkedProject, createProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";
import { HISTORY_TABLE, migrate, schemaHistoryTable, splitSqlOptions } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const entities = {
  "entities/User.ts": 'import type { Account } from "./Account";\nexport type User = { /** @unique */ email: string; account?: Account }',
  "entities/Account.ts": "/** @schema billing */\nexport type Account = { /** @unique */ name: string }",
};
const sqliteConfig = (path: string) =>
  `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }) });\n`;
const postgresConfig = (url: string) =>
  `import { defineConfig, postgresAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: postgresAdapter({ url: ${JSON.stringify(url)} }) });\n`;

async function asTenant<T>(schema: string, work: () => Promise<T>): Promise<T> {
  process.env.DATABASE_SCHEMA = schema;
  try {
    return await work();
  } finally {
    delete process.env.DATABASE_SCHEMA;
  }
}

const migrationSource = async (root: string) => readFileSync(join(root, (await addMigration(root, "Initial", at(0))).file), "utf8");
const brokenMigration = (createStatement: string) =>
  `export async function up(ctx) {\n  await ctx.sql(${JSON.stringify(createStatement)}, { schema: "billing" });\n  await ctx.sql("not valid sql");\n}\nexport async function down() {}\n`;

describe("generated statements", () => {
  test("SQLite statements on explicit-schema tables carry their schema", async () => {
    const source = await migrationSource(createLinkedProject({ ...entities, "quickservicets.config.ts": sqliteConfig(":memory:") }));
    expect(source).toMatch(/ctx\.sql\("CREATE TABLE `billing__accounts`[^\n]*, \{ schema: "billing" \}\);/);
    expect(source).toContain('ctx.sql("CREATE UNIQUE INDEX `billing_accounts_name_uq` ON `billing__accounts` (`name`);", { schema: "billing" });');
    const usersTable = source.split("\n").find((line) => line.includes("CREATE TABLE `{{default_schema}}users`"));
    expect(usersTable).toContain("REFERENCES `billing__accounts`");
    expect(usersTable).not.toContain("{ schema:");
  });

  test("PostgreSQL marks the schema, its tables and its indexes, not default tables referencing them", async () => {
    const source = await migrationSource(createLinkedProject({ ...entities, "quickservicets.config.ts": postgresConfig("postgres://localhost/none") }));
    const lines = source.split("\n");
    const line = (text: string) => lines.find((candidate) => candidate.includes(text)) ?? "";
    expect(line('CREATE SCHEMA IF NOT EXISTS \\"billing\\"')).toContain('{ schema: "billing" }');
    expect(line('CREATE TABLE \\"billing\\".\\"accounts\\"')).toContain('{ schema: "billing" }');
    expect(line('CREATE UNIQUE INDEX \\"billing_accounts_name_uq\\"')).toContain('{ schema: "billing" }');
    expect(line('CREATE TABLE \\"users\\"')).not.toContain("{ schema:");
    expect(line('ALTER TABLE \\"users\\" ADD CONSTRAINT')).not.toContain("{ schema:");
  });

  test("changes to an existing explicit-schema table stay marked, including table rebuilds and dropped indexes", async () => {
    const root = createLinkedProject({ ...entities, "quickservicets.config.ts": sqliteConfig(":memory:") });
    await addMigration(root, "Initial", at(0));
    const upCalls = async (body: string, name: string, seconds: number) => {
      writeFileSync(join(root, "entities/Account.ts"), `/** @schema billing */\nexport type Account = ${body}`);
      const source = readFileSync(join(root, (await addMigration(root, name, at(seconds))).file), "utf8");
      const up = source.slice(source.indexOf("export async function up"), source.indexOf("export async function down"));
      return up.split("\n").filter((line) => line.includes("ctx.sql("));
    };
    const dropUnique = await upCalls("{ name: string }", "DropUnique", 1);
    expect(dropUnique.find((line) => line.includes("DROP INDEX `billing_accounts_name_uq`"))).toContain('{ schema: "billing" }');
    const rebuild = await upCalls("{ name: string; status: 'open' | 'closed' }", "AddStatus", 2);
    expect(rebuild.some((line) => line.includes("CREATE TABLE `__new_billing__accounts`"))).toBe(true);
    for (const call of rebuild.filter((line) => !line.includes("PRAGMA"))) expect(call).toContain('{ schema: "billing" }');
  });
});

describe("history table names", () => {
  test("explicit schemas get a history table named like their tables", () => {
    expect(schemaHistoryTable("sqlite", "billing")).toBe(`billing__${HISTORY_TABLE}`);
    expect(schemaHistoryTable("sqlite", "billing-eu")).toBe(`billing_eu__${HISTORY_TABLE}`);
    expect(schemaHistoryTable("postgres", "billing-eu")).toBe(`"billing_eu".${HISTORY_TABLE}`);
  });
});

describe("statements without a schema", () => {
  test("bound values are not taken for options", () => {
    expect(splitSqlOptions("select ?", [5])).toEqual({ values: [5] });
    expect(splitSqlOptions("select 1", [{ schema: "billing" }])).toEqual({ values: [], schema: "billing" });
    const template = Object.assign(["select ", ""], { raw: ["select ", ""] }) as TemplateStringsArray;
    expect(splitSqlOptions(template, [{ schema: "billing" }])).toEqual({ values: [{ schema: "billing" }] });
  });

  test("a migration file with plain statements still applies", async () => {
    const path = join(createProject({}), "app.db");
    const root = createLinkedProject({
      "quickservicets.config.ts": sqliteConfig(path),
      "migrations/20261015120000_Plain.ts":
        'export async function up(ctx) {\n  await ctx.sql("create table notes (id text primary key, body text)");\n  await ctx.sql`insert into notes (id, body) values (${"n1"}, ${"hello"})`;\n  await ctx.sql("insert into notes (id, body) values (?, ?)", "n2", "bye");\n}\nexport async function down(ctx) {\n  await ctx.sql("drop table notes");\n}\n',
    });
    expect((await migrate(root)).applied).toEqual(["20261015120000_Plain"]);
    const database = new Database(path);
    expect(database.query("select count(*) as count from notes").get()).toEqual({ count: 2 });
    database.close();
  });
});

describe("two tenants on SQLite", () => {
  const setup = async () => {
    const path = join(createProject({}), "app.db");
    const root = createLinkedProject({ ...entities, "quickservicets.config.ts": sqliteConfig(path) });
    await addMigration(root, "Initial", at(0));
    return { root, path };
  };
  const query = <T>(path: string, text: string) => {
    const database = new Database(path);
    try {
      return database.query(text).all() as T[];
    } finally {
      database.close();
    }
  };

  test("each tenant gets its own tables and the shared schema is created once", async () => {
    const { root, path } = await setup();
    expect((await asTenant("tenant-a", () => migrate(root))).applied).toEqual(["20261015120000_Initial"]);
    expect((await asTenant("tenant-b", () => migrate(root))).applied).toEqual(["20261015120000_Initial"]);
    const tables = query<{ name: string }>(path, "select name from sqlite_master where type = 'table' order by name").map((row) => row.name);
    expect(tables).toContain("tenant_a__users");
    expect(tables).toContain("tenant_b__users");
    expect(tables.filter((name) => name.endsWith("accounts"))).toEqual(["billing__accounts"]);
    const records = query<{ id: string; name: string; default_schemas: string; applied_at: number }>(
      path,
      `select * from ${schemaHistoryTable("sqlite", "billing")}`,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "20261015120000_Initial", name: "Initial" });
    expect(records[0]!.applied_at).toBeGreaterThan(0);
    expect(JSON.parse(records[0]!.default_schemas)).toEqual(["tenant-a", "tenant-b"]);
    expect(query<{ id: string }>(path, `select id from tenant_b__${HISTORY_TABLE}`)).toEqual([{ id: "20261015120000_Initial" }]);
  });

  test("a failing statement leaves both histories without the migration", async () => {
    const { root, path } = await setup();
    await asTenant("tenant-a", () => migrate(root));
    writeFileSync(join(root, "migrations/20261015120001_Broken.ts"), brokenMigration("create table billing__extra (id text)"));
    await expect(asTenant("tenant-a", () => migrate(root))).rejects.toThrow("20261015120001_Broken");
    expect(query<{ id: string }>(path, `select id from tenant_a__${HISTORY_TABLE}`)).toEqual([{ id: "20261015120000_Initial" }]);
    expect(query<{ id: string }>(path, `select id from ${schemaHistoryTable("sqlite", "billing")}`)).toEqual([{ id: "20261015120000_Initial" }]);
    expect(query(path, "select name from sqlite_master where name = 'billing__extra'")).toEqual([]);
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  describe("two tenants on PostgreSQL", () => {
    const reset = async () => {
      const admin = new SQL(postgresUrl);
      await admin.unsafe(
        "drop schema if exists public cascade; create schema public; drop schema if exists billing cascade; drop schema if exists tenant_a cascade; drop schema if exists tenant_b cascade;",
      );
      await admin.close();
    };
    const query = async <T>(text: string) => {
      const admin = new SQL(postgresUrl);
      try {
        // quickservicets-allow-unsafe: runs the literal queries this test file passes to it
        return (await admin.unsafe(text)) as T[];
      } finally {
        await admin.close();
      }
    };
    const setup = async () => {
      await reset();
      const root = createLinkedProject({ ...entities, "quickservicets.config.ts": postgresConfig(postgresUrl) });
      await addMigration(root, "Initial", at(0));
      return root;
    };

    test("each tenant gets its own tables and the shared schema is created once", async () => {
      const root = await setup();
      expect((await asTenant("tenant-a", () => migrate(root))).applied).toEqual(["20261015120000_Initial"]);
      expect((await asTenant("tenant-b", () => migrate(root))).applied).toEqual(["20261015120000_Initial"]);
      const tables = await query<{ name: string }>(
        "select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('billing', 'tenant_a', 'tenant_b') and table_name in ('users', 'accounts', '__quickservicets_migrations') order by 1",
      );
      expect(tables.map((row) => row.name)).toEqual([
        "billing.__quickservicets_migrations",
        "billing.accounts",
        "tenant_a.__quickservicets_migrations",
        "tenant_a.users",
        "tenant_b.__quickservicets_migrations",
        "tenant_b.users",
      ]);
      const records = await query<{ id: string; default_schemas: string }>(`select id, default_schemas from ${schemaHistoryTable("postgres", "billing")}`);
      expect(records.map((row) => ({ id: row.id, defaults: JSON.parse(row.default_schemas) }))).toEqual([
        { id: "20261015120000_Initial", defaults: ["tenant-a", "tenant-b"] },
      ]);
    });

    test("a failing statement leaves both histories without the migration", async () => {
      const root = await setup();
      await asTenant("tenant-a", () => migrate(root));
      writeFileSync(join(root, "migrations/20261015120001_Broken.ts"), brokenMigration('create table "billing"."extra" (id text)'));
      await expect(asTenant("tenant-a", () => migrate(root))).rejects.toThrow("20261015120001_Broken");
      expect(await query<{ id: string }>(`select id from tenant_a.${HISTORY_TABLE}`)).toEqual([{ id: "20261015120000_Initial" }]);
      expect(await query<{ id: string }>(`select id from billing.${HISTORY_TABLE}`)).toEqual([{ id: "20261015120000_Initial" }]);
      expect(await query("select 1 from information_schema.tables where table_schema = 'billing' and table_name = 'extra'")).toEqual([]);
    });
  });
} else {
  test.skip("PostgreSQL migration history per schema (set TEST_POSTGRES_URL to run)", () => {});
}
