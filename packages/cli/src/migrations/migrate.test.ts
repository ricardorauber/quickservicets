import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { run } from "../run.ts";
import { addMigration } from "./add.ts";
import { HISTORY_TABLE, migrate } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));

async function sqliteProject(production = false) {
  const root = createLinkedProject({ "entities/User.ts": "export type User = { email: string }" });
  const path = join(root, "app.db");
  writeFileSync(
    join(root, "quickservicets.config.ts"),
    `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }), production: ${production} });\n`,
  );
  await addMigration(root, "Initial", at(0));
  writeFileSync(join(root, "entities/User.ts"), "export type User = { email: string; age?: number }");
  await addMigration(root, "AddAge", at(1));
  return { root, path };
}

const columns = (path: string) => {
  const database = new Database(path);
  try {
    return (database.query("pragma table_info(users)").all() as { name: string }[]).map((column) => column.name);
  } finally {
    database.close();
  }
};
const history = (path: string) => {
  const database = new Database(path);
  try {
    return (database.query(`select id from ${HISTORY_TABLE} order by id`).all() as { id: string }[]).map((row) => row.id);
  } finally {
    database.close();
  }
};

describe("applying and re-applying", () => {
  test("applies every pending migration and records it", async () => {
    const { root, path } = await sqliteProject();
    const result = await migrate(root);
    expect(result.applied).toEqual(["20261015120000_Initial", "20261015120001_AddAge"]);
    expect(columns(path)).toContain("age");
    expect(history(path)).toEqual(result.applied);
  });
  test("a second run applies nothing", async () => {
    const { root } = await sqliteProject();
    await migrate(root);
    expect(await migrate(root)).toMatchObject({ applied: [], reverted: [], messages: ["Database is up to date (0 migrations applied)"] });
  });
});

describe("reverting to a target", () => {
  test("by name, then forward again", async () => {
    const { root, path } = await sqliteProject();
    await migrate(root);
    expect((await migrate(root, { target: "Initial" })).reverted).toEqual(["20261015120001_AddAge"]);
    expect(columns(path)).not.toContain("age");
    expect((await migrate(root, { target: "20261015120001_AddAge" })).applied).toEqual(["20261015120001_AddAge"]);
    expect(columns(path)).toContain("age");
  });
  test("to 0 reverts everything newest first", async () => {
    const { root, path } = await sqliteProject();
    await migrate(root);
    expect((await migrate(root, { target: "0" })).reverted).toEqual(["20261015120001_AddAge", "20261015120000_Initial"]);
    expect(history(path)).toEqual([]);
    expect(columns(path)).toEqual([]);
  });
});

test("a failing migration rolls back alone and stops", async () => {
  const { root, path } = await sqliteProject();
  writeFileSync(
    join(root, "migrations/20261015120002_Broken.ts"),
    'export async function up(ctx) { await ctx.sql("create table partial (id text)"); await ctx.sql("not valid sql"); }\nexport async function down() {}\n',
  );
  const errors: string[] = [];
  expect(await run(["migrate"], { log: () => {}, error: (line) => errors.push(line) }, root)).toBe(1);
  expect(errors[0]).toContain("20261015120002_Broken");
  expect(history(path)).toEqual(["20261015120000_Initial", "20261015120001_AddAge"]);
  const database = new Database(path);
  expect(database.query("select name from sqlite_master where name = 'partial'").get()).toBeNull();
  database.close();
});

describe("production guard", () => {
  test("reverting requires --force", async () => {
    const { root } = await sqliteProject(true);
    await migrate(root);
    await expect(migrate(root, { target: "Initial" })).rejects.toThrow("Reverting migrations in production requires --force");
    expect((await migrate(root, { target: "Initial", force: true })).reverted).toEqual(["20261015120001_AddAge"]);
  });
  test("applying does not", async () => {
    const { root } = await sqliteProject(true);
    expect((await migrate(root)).applied).toHaveLength(2);
  });
});

describe("missing migrations", () => {
  test("unknown targets are named", async () => {
    const { root } = await sqliteProject();
    await expect(migrate(root, { target: "Nope" })).rejects.toThrow("Nope");
  });
  test("applied files missing on disk are named", async () => {
    const { root } = await sqliteProject();
    await migrate(root);
    rmSync(join(root, "migrations/20261015120001_AddAge.ts"));
    await expect(migrate(root, { target: "0" })).rejects.toThrow("20261015120001_AddAge");
  });
});

test("the memory adapter has nothing to migrate", async () => {
  const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG });
  const logs: string[] = [];
  expect(await run(["migrate"], { log: (line) => logs.push(line), error: () => {} }, root)).toBe(0);
  expect(logs[0]).toContain("Nothing to migrate");
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  test("PostgreSQL run", async () => {
    const { SQL } = await import("bun");
    const admin = new SQL(postgresUrl);
    await admin.unsafe("drop schema if exists public cascade; create schema public;");
    await admin.close();
    const root = createLinkedProject({
      "quickservicets.config.ts": `import { defineConfig, postgresAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: postgresAdapter({ url: ${JSON.stringify(postgresUrl)} }) });\n`,
      "entities/User.ts": "export type User = { email: string }",
    });
    await addMigration(root, "Initial", at(0));
    expect((await migrate(root)).applied).toEqual(["20261015120000_Initial"]);
    expect((await migrate(root, { target: "0" })).reverted).toEqual(["20261015120000_Initial"]);
  });
} else {
  test.skip("PostgreSQL migrate run (set TEST_POSTGRES_URL to run)", () => {});
}
