import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { MongoClient } from "mongodb";
import { LEGACY_MIGRATIONS_TABLE, MIGRATIONS_TABLE, sqliteAdapter, startService, type ServiceConfig } from "@quickservicets/core";
import { createLinkedProject, createProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";
import { migrate } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const entities = {
  "entities/User.ts": 'import type { Account } from "./Account";\nexport type User = { /** @unique */ email: string; account?: Account }',
  "entities/Account.ts": "/** @schema billing */\nexport type Account = { /** @unique */ name: string }",
};
const configFile = (adapter: string, options: Record<string, string>) =>
  `import { defineConfig, ${adapter} } from "@quickservicets/core";\nexport default defineConfig({ database: ${adapter}(${JSON.stringify(options)}) });\n`;
const SECOND = "20261015120001_Second";
const addSecondMigration = (root: string) => writeFileSync(join(root, `migrations/${SECOND}.ts`), "export async function up() {}\nexport async function down() {}\n");

async function asTenant<T>(schema: string | undefined, work: () => Promise<T>): Promise<T> {
  if (schema === undefined) return work();
  process.env.DATABASE_SCHEMA = schema;
  try {
    return await work();
  } finally {
    delete process.env.DATABASE_SCHEMA;
  }
}

describe("SQLite", () => {
  const tables = (path: string) => {
    const database = new Database(path);
    try {
      return (database.query("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[]).map((row) => row.name);
    } finally {
      database.close();
    }
  };
  const renameBack = (path: string) => {
    const database = new Database(path);
    try {
      for (const name of tables(path).filter((table) => table.endsWith(MIGRATIONS_TABLE))) {
        database.run(`alter table "${name}" rename to "${name.replace(MIGRATIONS_TABLE, LEGACY_MIGRATIONS_TABLE)}"`);
      }
    } finally {
      database.close();
    }
  };

  test("migrate renames the old tables of the default, tenant and explicit schemas once and keeps their history", async () => {
    const path = join(createProject({}), "app.db");
    const root = createLinkedProject({ ...entities, "quickservicets.config.ts": configFile("sqliteAdapter", { path }) });
    await addMigration(root, "Initial", at(0));
    await migrate(root);
    await asTenant("tenant-a", () => migrate(root));
    renameBack(path);
    expect(tables(path).filter((name) => name.includes(LEGACY_MIGRATIONS_TABLE))).toHaveLength(3);
    addSecondMigration(root);

    const first = await migrate(root);
    expect(first.applied).toEqual([SECOND]);
    expect(first.renamed.map((table) => table.to).sort()).toEqual([MIGRATIONS_TABLE, `billing__${MIGRATIONS_TABLE}`, `tenant_a__${MIGRATIONS_TABLE}`]);
    const tenant = await asTenant("tenant-a", () => migrate(root));
    expect(tenant.applied).toEqual([SECOND]);
    expect(tenant.renamed).toEqual([]);
    expect(tables(path).filter((name) => name.includes(LEGACY_MIGRATIONS_TABLE))).toEqual([]);
    expect((await migrate(root)).applied).toEqual([]);
  });

  test("startup renames the old table and logs it", async () => {
    const path = join(createProject({}), "app.db");
    const database = new Database(path);
    database.run(`create table ${LEGACY_MIGRATIONS_TABLE} (id text primary key, name text not null, applied_at integer not null)`);
    database.run(`insert into ${LEGACY_MIGRATIONS_TABLE} values ('20261015120000_Initial', 'Initial', 0)`);
    database.close();
    const free = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = free.port;
    await free.stop(true);
    const lines: Record<string, unknown>[] = [];
    const logger = { info: (entry: Record<string, unknown>) => void lines.push(entry), warn() {}, error() {} };
    const service = await startService({
      projectConfig: { database: sqliteAdapter({ path }), logger, server: { port } } as unknown as ServiceConfig,
      models: [],
      crudRoutes: [],
      endpoints: [],
      hooks: new Map(),
      env: {},
      process: { once: () => undefined, exit: () => undefined } as never,
    });
    try {
      expect(lines.find((line) => line.message === "migrations.table.renamed")).toMatchObject({ from: LEGACY_MIGRATIONS_TABLE, to: MIGRATIONS_TABLE });
    } finally {
      await service?.stop();
    }
    expect(tables(path)).toContain(MIGRATIONS_TABLE);
    expect(tables(path)).not.toContain(LEGACY_MIGRATIONS_TABLE);
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  describe("PostgreSQL", () => {
    const query = async <T>(text: string) => {
      const admin = new SQL(postgresUrl);
      try {
        // quickservicets-allow-unsafe: runs the literal queries this test file passes to it
        return (await admin.unsafe(text)) as T[];
      } finally {
        await admin.close();
      }
    };
    const historyTables = async (name: string) =>
      (
        await query<{ name: string }>(
          `select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('public', 'billing', 'tenant_a') and table_name = '${name}' order by 1`,
        )
      ).map(
        (row) => row.name,
      );

    test("migrate renames the old tables of the default, tenant and explicit schemas once and keeps their history", async () => {
      await query("drop schema if exists public cascade; create schema public; drop schema if exists billing cascade; drop schema if exists tenant_a cascade;");
      const root = createLinkedProject({ ...entities, "quickservicets.config.ts": configFile("postgresAdapter", { url: postgresUrl }) });
      await addMigration(root, "Initial", at(0));
      await migrate(root);
      await asTenant("tenant-a", () => migrate(root));
      for (const name of await historyTables(MIGRATIONS_TABLE)) {
        const [schema] = name.split(".");
        await query(`alter table "${schema}".${MIGRATIONS_TABLE} rename to ${LEGACY_MIGRATIONS_TABLE}`);
      }
      expect(await historyTables(LEGACY_MIGRATIONS_TABLE)).toEqual([`billing.${LEGACY_MIGRATIONS_TABLE}`, `public.${LEGACY_MIGRATIONS_TABLE}`, `tenant_a.${LEGACY_MIGRATIONS_TABLE}`]);
      addSecondMigration(root);

      const first = await migrate(root);
      expect(first.applied).toEqual([SECOND]);
      expect(first.renamed.map((table) => table.to)).toEqual([`billing.${MIGRATIONS_TABLE}`, `public.${MIGRATIONS_TABLE}`, `tenant_a.${MIGRATIONS_TABLE}`]);
      expect((await asTenant("tenant-a", () => migrate(root))).applied).toEqual([SECOND]);
      expect(await historyTables(LEGACY_MIGRATIONS_TABLE)).toEqual([]);
      expect(await historyTables(MIGRATIONS_TABLE)).toEqual([`billing.${MIGRATIONS_TABLE}`, `public.${MIGRATIONS_TABLE}`, `tenant_a.${MIGRATIONS_TABLE}`]);
      expect((await migrate(root)).applied).toEqual([]);
    });
  });
} else {
  test.skip("PostgreSQL migrations table rename (set TEST_POSTGRES_URL to run)", () => {});
}

const mongoUrl = process.env.TEST_MONGODB_URL;
if (mongoUrl) {
  test("MongoDB keeps its history collection, which carries no product name, across the rename", async () => {
    const database = `ss_legacy_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const root = createLinkedProject({
      "quickservicets.config.ts": configFile("mongodbAdapter", { url: mongoUrl, database }),
      "entities/User.ts": "export type User = { /** @unique */ email: string }",
    });
    await addMigration(root, "Initial", at(0));
    const client = await MongoClient.connect(mongoUrl);
    try {
      expect((await migrate(root)).applied).toEqual(["20261015120000_Initial"]);
      addSecondMigration(root);
      const second = await migrate(root);
      expect(second.applied).toEqual([SECOND]);
      expect(second.renamed).toEqual([]);
      const collections = (await client.db(database).listCollections().toArray()).map((collection) => collection.name);
      expect(collections).not.toContain(LEGACY_MIGRATIONS_TABLE);
    } finally {
      await client.db(database).dropDatabase();
      await client.close();
    }
  });
} else {
  test.skip("MongoDB migration history across the rename (set TEST_MONGODB_URL to run)", () => {});
}
