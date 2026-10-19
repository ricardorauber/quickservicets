import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { createLinkedProject, createProject } from "../testing/project.ts";
import { run } from "../run.ts";
import { addMigration } from "./add.ts";
import { formatSchemaCounts } from "./list-remove.ts";
import { HISTORY_TABLE, migrate, schemaHistoryTable } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const INITIAL = "20261015120000_Initial";
const entities = {
  "entities/User.ts": 'import type { Account } from "./Account";\nexport type User = { /** @unique */ email: string; account?: Account }',
  "entities/Account.ts": "/** @schema billing */\nexport type Account = { /** @unique */ name: string }",
};
const sqliteConfig = (path: string) =>
  `import { defineConfig, sqliteAdapter } from "@quickservice/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }) });\n`;
const postgresConfig = (url: string) =>
  `import { defineConfig, postgresAdapter } from "@quickservice/core";\nexport default defineConfig({ database: postgresAdapter({ url: ${JSON.stringify(url)} }) });\n`;

async function asTenant<T>(schema: string, work: () => Promise<T>): Promise<T> {
  process.env.DATABASE_SCHEMA = schema;
  try {
    return await work();
  } finally {
    delete process.env.DATABASE_SCHEMA;
  }
}

const downOf = (source: string) => source.slice(source.indexOf("export async function down")).split("\n");
const line = (lines: string[], text: string) => lines.find((candidate) => candidate.includes(text)) ?? "";
/** A migration whose `down` changes the shared schema and then fails. */
const failingDown = (create: string, drop: string) =>
  `export async function up(ctx) {\n  await ctx.sql(${JSON.stringify(create)}, { schema: "billing" });\n}\nexport async function down(ctx) {\n  await ctx.sql(${JSON.stringify(drop)}, { schema: "billing" });\n  await ctx.sql("not valid sql");\n}\n`;

describe("generated down statements", () => {
  test("SQLite marks drops of explicit-schema tables", async () => {
    const root = createLinkedProject({ ...entities, "quickservice.config.ts": sqliteConfig(":memory:") });
    const down = downOf(readFileSync(join(root, (await addMigration(root, "Initial", at(0))).file), "utf8"));
    expect(line(down, "DROP TABLE `billing__accounts`")).toContain('{ schema: "billing" }');
    expect(line(down, "DROP TABLE `{{default_schema}}users`")).not.toContain("{ schema:");
  });

  test("PostgreSQL marks drops of explicit-schema tables and of the schema", async () => {
    const root = createLinkedProject({ ...entities, "quickservice.config.ts": postgresConfig("postgres://localhost/none") });
    const down = downOf(readFileSync(join(root, (await addMigration(root, "Initial", at(0))).file), "utf8"));
    expect(line(down, 'DROP TABLE \\"billing\\".\\"accounts\\"')).toContain('{ schema: "billing" }');
    expect(line(down, 'DROP SCHEMA \\"billing\\"')).toContain('{ schema: "billing" }');
    expect(line(down, 'DROP TABLE \\"users\\"')).not.toContain("{ schema:");
  });
});

test("schema counts read as tenants", () => {
  expect(formatSchemaCounts([{ schema: "billing", tenants: 2 }, { schema: "auth", tenants: 1 }])).toBe("billing: 2 tenants, auth: 1 tenant");
});

const listLines = async (root: string, tenant: string) => {
  const lines: string[] = [];
  expect(await asTenant(tenant, () => run(["migration", "list"], { log: (text) => lines.push(text), error: () => {} }, root))).toBe(0);
  return lines;
};

describe("reverting with two tenants on SQLite", () => {
  const setup = async () => {
    const path = join(createProject({}), "app.db");
    const root = createLinkedProject({ ...entities, "quickservice.config.ts": sqliteConfig(path) });
    await addMigration(root, "Initial", at(0));
    await asTenant("tenant-a", () => migrate(root));
    await asTenant("tenant-b", () => migrate(root));
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
  const tables = (path: string) => query<{ name: string }>(path, "select name from sqlite_master where type = 'table'").map((row) => row.name);
  const billingRecords = (path: string) =>
    query<{ id: string; default_schemas: string }>(path, `select id, default_schemas from ${schemaHistoryTable("sqlite", "billing")}`).map(
      (row) => ({ id: row.id, defaults: JSON.parse(row.default_schemas) as string[] }),
    );

  test("the shared tables stay until the last tenant reverts", async () => {
    const { root, path } = await setup();
    expect((await asTenant("tenant-a", () => migrate(root, { target: "0" }))).reverted).toEqual([INITIAL]);
    expect(tables(path)).not.toContain("tenant_a__users");
    expect(tables(path)).toContain("tenant_b__users");
    expect(tables(path)).toContain("billing__accounts");
    expect(billingRecords(path)).toEqual([{ id: INITIAL, defaults: ["tenant-b"] }]);

    expect((await asTenant("tenant-b", () => migrate(root, { target: "0" }))).reverted).toEqual([INITIAL]);
    expect(tables(path)).not.toContain("tenant_b__users");
    expect(tables(path)).not.toContain("billing__accounts");
    expect(billingRecords(path)).toEqual([]);
  });

  test("a failing down leaves both histories unchanged", async () => {
    const path = join(createProject({}), "app.db");
    const root = createLinkedProject({ ...entities, "quickservice.config.ts": sqliteConfig(path) });
    await addMigration(root, "Initial", at(0));
    writeFileSync(
      join(root, "migrations/20261015120001_Extra.ts"),
      failingDown("create table billing__extra (id text)", "drop table billing__extra"),
    );
    await asTenant("tenant-a", () => migrate(root));
    await expect(asTenant("tenant-a", () => migrate(root, { target: "Initial" }))).rejects.toThrow("20261015120001_Extra");
    expect(query<{ id: string }>(path, `select id from tenant_a__${HISTORY_TABLE} order by id`).map((row) => row.id)).toEqual([
      INITIAL,
      "20261015120001_Extra",
    ]);
    expect(billingRecords(path)).toEqual([
      { id: INITIAL, defaults: ["tenant-a"] },
      { id: "20261015120001_Extra", defaults: ["tenant-a"] },
    ]);
    expect(tables(path)).toContain("billing__extra");
  });

  test("migration list shows how many tenants applied each migration in its explicit schemas", async () => {
    const { root } = await setup();
    expect(await listLines(root, "tenant-a")).toEqual([`${INITIAL}  applied  billing: 2 tenants`]);
    await asTenant("tenant-a", () => migrate(root, { target: "0" }));
    expect(await listLines(root, "tenant-a")).toEqual([`${INITIAL}  pending  billing: 1 tenant`]);
    expect(await listLines(root, "tenant-b")).toEqual([`${INITIAL}  applied  billing: 1 tenant`]);
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  describe("reverting with two tenants on PostgreSQL", () => {
    const query = async <T>(text: string) => {
      const admin = new SQL(postgresUrl);
      try {
        return (await admin.unsafe(text)) as T[];
      } finally {
        await admin.close();
      }
    };
    const reset = () =>
      query(
        "drop schema if exists public cascade; create schema public; drop schema if exists billing cascade; drop schema if exists tenant_a cascade; drop schema if exists tenant_b cascade;",
      );
    const project = async () => {
      await reset();
      const root = createLinkedProject({ ...entities, "quickservice.config.ts": postgresConfig(postgresUrl) });
      await addMigration(root, "Initial", at(0));
      return root;
    };
    const tables = async () =>
      (
        await query<{ name: string }>(
          "select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('billing', 'tenant_a', 'tenant_b') order by 1",
        )
      ).map((row) => row.name);
    const billingRecords = async () =>
      (await query<{ id: string; default_schemas: string }>(`select id, default_schemas from ${schemaHistoryTable("postgres", "billing")} order by id`)).map(
        (row) => ({ id: row.id, defaults: JSON.parse(row.default_schemas) as string[] }),
      );

    test("the shared schema stays until the last tenant reverts", async () => {
      const root = await project();
      await asTenant("tenant-a", () => migrate(root));
      await asTenant("tenant-b", () => migrate(root));
      expect(await listLines(root, "tenant-a")).toEqual([`${INITIAL}  applied  billing: 2 tenants`]);

      await asTenant("tenant-a", () => migrate(root, { target: "0" }));
      expect(await tables()).not.toContain("tenant_a.users");
      expect(await tables()).toContain("tenant_b.users");
      expect(await tables()).toContain("billing.accounts");
      expect(await billingRecords()).toEqual([{ id: INITIAL, defaults: ["tenant-b"] }]);
      expect(await listLines(root, "tenant-a")).toEqual([`${INITIAL}  pending  billing: 1 tenant`]);

      await asTenant("tenant-b", () => migrate(root, { target: "0" }));
      expect((await tables()).filter((name) => name.startsWith("billing.") || name.endsWith(".users"))).toEqual([]);
      expect(await query("select 1 from information_schema.schemata where schema_name = 'billing'")).toEqual([]);
    });

    test("a failing down leaves both histories unchanged", async () => {
      const root = await project();
      writeFileSync(
        join(root, "migrations/20261015120001_Extra.ts"),
        failingDown('create table "billing"."extra" (id text)', 'drop table "billing"."extra"'),
      );
      await asTenant("tenant-a", () => migrate(root));
      await expect(asTenant("tenant-a", () => migrate(root, { target: "Initial" }))).rejects.toThrow("20261015120001_Extra");
      expect((await query<{ id: string }>(`select id from tenant_a.${HISTORY_TABLE} order by id`)).map((row) => row.id)).toEqual([
        INITIAL,
        "20261015120001_Extra",
      ]);
      expect(await billingRecords()).toEqual([
        { id: INITIAL, defaults: ["tenant-a"] },
        { id: "20261015120001_Extra", defaults: ["tenant-a"] },
      ]);
      expect(await tables()).toContain("billing.extra");
    });
  });
} else {
  test.skip("PostgreSQL migration revert per schema (set TEST_POSTGRES_URL to run)", () => {});
}
