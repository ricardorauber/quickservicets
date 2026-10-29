import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { buildDrizzleSchema, createApp, loadConfig } from "@quickservicets/core";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { build } from "../build/build.ts";
import { parseEntities } from "../entities/parse-entities.ts";
import { createLinkedProject, createProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";
import { migrate } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const entities = {
  "entities/User.ts": 'import type { User as AuthUser } from "./auth/User";\nexport type User = { /** @unique */ email: string; account?: AuthUser }',
  "entities/auth/User.ts": "export type User = { /** @unique */ email: string }",
};
const models = () => parseEntities(createProject(entities));

describe("drizzle schema", () => {
  test("PostgreSQL uses pgSchema for explicit schemas", () => {
    const { tables } = buildDrizzleSchema(models(), "postgres");
    expect(pgTableConfig(tables["auth/User"] as never)).toMatchObject({ name: "users", schema: "auth" });
    expect(pgTableConfig(tables.User as never).schema).toBeUndefined();
  });
  test("SQLite prefixes explicit schemas and the default prefix", () => {
    const { tables } = buildDrizzleSchema(models(), "sqlite", { sqliteDefaultPrefix: "tenant_a__" });
    expect(sqliteTableConfig(tables["auth/User"] as never).name).toBe("auth__users");
    expect(sqliteTableConfig(tables.User as never).name).toBe("tenant_a__users");
  });
  test("index names include the schema", () => {
    const { tables } = buildDrizzleSchema(models(), "postgres");
    expect(pgTableConfig(tables["auth/User"] as never).indexes.map((index) => index.config.name)).toContain("auth_users_email_uq");
    expect(pgTableConfig(tables.User as never).indexes.map((index) => index.config.name)).toContain("users_email_uq");
  });
});

function sqliteProject(path: string) {
  return createLinkedProject({
    ...entities,
    "quickservicets.config.ts": `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }) });\n`,
  });
}

describe("SQLite storage", () => {
  test("explicit schema tables and the default placeholder", async () => {
    const root = sqliteProject(":memory:");
    const source = readFileSync(join(root, (await addMigration(root, "Initial", at(0))).file), "utf8");
    expect(source).toContain("CREATE TABLE `auth__users`");
    expect(source).toContain("CREATE TABLE `{{default_schema}}users`");
    expect(source).toContain("REFERENCES `auth__users`(`id`)");
  });

  test("the placeholder resolves per default schema and the foreign key works", async () => {
    for (const [schema, table] of [["tenant-a", "tenant_a__users"], [undefined, "users"]] as const) {
      const path = join(createProject({}), "app.db");
      const root = sqliteProject(path);
      await addMigration(root, "Initial", at(0));
      if (schema) process.env.DATABASE_SCHEMA = schema;
      try {
        await migrate(root);
      } finally {
        delete process.env.DATABASE_SCHEMA;
      }
      const database = new Database(path);
      const names = (database.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((row) => row.name);
      expect(names).toContain(table);
      expect(names).toContain("auth__users");
      database.run("PRAGMA foreign_keys = ON");
      expect(() =>
        database.run(`insert into ${table} (id, created_at, updated_at, email, account) values ('u', 0, 0, 'a@b.co', 'missing')`),
      ).toThrow(/FOREIGN KEY/);
      database.close();
    }
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  describe("PostgreSQL storage", () => {
    const pgProject = () =>
      createLinkedProject({
        ...entities,
        "quickservicets.config.ts": `import { defineConfig, postgresAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: postgresAdapter({ url: ${JSON.stringify(postgresUrl)} }) });\n`,
      });
    const reset = async () => {
      const admin = new SQL(postgresUrl);
      await admin.unsafe('drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; drop schema if exists tenant_a cascade;');
      await admin.close();
    };

    test("migration creates explicit schemas when missing and keeps default tables unqualified", async () => {
      const root = pgProject();
      const source = readFileSync(join(root, (await addMigration(root, "Initial", at(0))).file), "utf8");
      expect(source).toContain('CREATE SCHEMA IF NOT EXISTS \\"auth\\"');
      expect(source).toContain('CREATE TABLE \\"users\\"');
      expect(source).not.toContain('\\"public\\".');
      expect(source.indexOf("CREATE SCHEMA")).toBeLessThan(source.indexOf('CREATE TABLE \\"auth\\".\\"users\\"'));
    });

    test("DATABASE_SCHEMA puts default tables, history and requests in that schema", async () => {
      await reset();
      const root = pgProject();
      await addMigration(root, "Initial", at(0));
      process.env.DATABASE_SCHEMA = "tenant-a";
      try {
        await migrate(root);
        await build(root);
        const { models: generated } = await import(join(root, ".generated/models.ts"));
        const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
        const config = await loadConfig(root);
        await config.database.connect(generated, { defaultSchema: config.schema });
        const { server } = createApp({ models: generated, crudRoutes, endpoints, hooks, config: { ...config, logger: { info() {}, warn() {}, error() {} } } });
        const account = await (await server.fetch(new Request("http://x/auth/users", { method: "POST", body: '{"email":"a@b.co"}' }))).json() as { id: string };
        const created = await server.fetch(new Request("http://x/users", { method: "POST", body: JSON.stringify({ email: "a@b.co", account: account.id }) }));
        expect(created.status).toBe(201);
        expect((await (await server.fetch(new Request("http://x/users"))).json() as { total: number }).total).toBe(1);
        await config.database.disconnect();
      } finally {
        delete process.env.DATABASE_SCHEMA;
      }
      const admin = new SQL(postgresUrl);
      const tables = (await admin.unsafe(
        "select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('tenant_a', 'auth', 'public') order by 1",
      )) as { name: string }[];
      expect(tables.map((row) => row.name)).toEqual(["auth.__quickservicets_migrations", "auth.users", "tenant_a.__quickservicets_migrations", "tenant_a.users"]);
      const rows = (await admin.unsafe("select count(*)::int as count from tenant_a.users")) as { count: number }[];
      expect(rows[0]?.count).toBe(1);
      await admin.close();
    });
  });
} else {
  test.skip("PostgreSQL schema storage (set TEST_POSTGRES_URL to run)", () => {});
}

test("unique indexes in two schemas do not clash", async () => {
  const path = join(createProject({}), "app.db");
  const root = sqliteProject(path);
  await addMigration(root, "Initial", at(0));
  await migrate(root);
  const database = new Database(path);
  const indexes = (database.query("select name from sqlite_master where type = 'index' and name like '%email_uq'").all() as { name: string }[]).map((row) => row.name).sort();
  expect(indexes).toEqual(["auth_users_email_uq", "users_email_uq"]);
  database.close();
  writeFileSync(join(root, "unused"), "");
});
