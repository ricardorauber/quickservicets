import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../build/build.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";
import { listMigrationStatus } from "./list-remove.ts";
import { migrate } from "./migrate.ts";
import { HISTORY_TABLE } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));

/** A project with a default SQLite database and a named SQLite `orders`, plus `extra` named databases written as code. */
function project(files: Record<string, string> = {}, extra = "") {
  const root = createLinkedProject({
    "entities/Customer.ts": "export type Customer = { name: string };\n",
    "entities/orders/Order.ts": "export type Order = { number: string };\n",
    ...files,
  });
  writeFileSync(
    join(root, "quickservicets.config.ts"),
    `import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({
  database: sqliteAdapter({ path: ${JSON.stringify(join(root, "main.db"))} }),
  databases: { orders: sqliteAdapter({ path: ${JSON.stringify(join(root, "orders.db"))} })${extra} },
});
`,
  );
  return root;
}
const migrationFiles = (root: string, folder: string) => (existsSync(join(root, folder)) ? readdirSync(join(root, folder)).filter((entry) => entry.endsWith(".ts")).sort() : []);
const tables = (root: string, file: string) => {
  const db = new Database(join(root, file));
  try {
    return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
};
const cli = async (root: string, args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
  return { code, out, err };
};

describe("folders and snapshots per database", () => {
  test("a project without databases keeps migrations/ and meta/ only", async () => {
    const root = createLinkedProject({ "entities/Customer.ts": "export type Customer = { name: string };\n" });
    writeFileSync(join(root, "quickservicets.config.ts"), `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(join(root, "app.db"))} }) });\n`);
    const created = await addMigration(root, "Init", at(0));
    expect(created).toMatchObject({ database: "default", file: "migrations/20261015120000_Init.ts", migrations: [{ database: "default" }], skipped: [] });
    expect(readdirSync(join(root, "migrations")).sort()).toEqual(["20261015120000_Init.ts", "meta"]);
    expect((await migrate(root)).messages).toEqual(["Applied 20261015120000_Init"]);
  });

  test("each database gets its folder with only its models, and later changes write only where the model changed", async () => {
    const root = project();
    const first = await addMigration(root, "Init", at(0));
    expect(first.migrations.map((migration) => [migration.database, migration.file])).toEqual([
      ["default", "migrations/20261015120000_Init.ts"],
      ["orders", "migrations/orders/20261015120000_Init.ts"],
    ]);
    expect(readFileSync(join(root, "migrations/20261015120000_Init.ts"), "utf8")).toContain("customers");
    expect(readFileSync(join(root, "migrations/20261015120000_Init.ts"), "utf8")).not.toContain("CREATE TABLE `orders");
    expect(existsSync(join(root, "migrations/orders/meta/20261015120000_Init.snapshot.json"))).toBe(true);
    writeFileSync(join(root, "entities/orders/Order.ts"), "export type Order = { number: string; note?: string };\n");
    const second = await addMigration(root, "AddNote", at(1));
    expect(second.migrations.map((migration) => migration.file)).toEqual(["migrations/orders/20261015120001_AddNote.ts"]);
    expect(migrationFiles(root, "migrations")).toEqual(["20261015120000_Init.ts"]);
    writeFileSync(join(root, "entities/Coupon.ts"), "export type Coupon = { code: string };\n");
    writeFileSync(join(root, "entities/orders/Refund.ts"), "export type Refund = { amount: number };\n");
    const third = await addMigration(root, "AddCouponsAndRefunds", at(2));
    expect(third.migrations.map((migration) => migration.file)).toEqual(["migrations/20261015120002_AddCouponsAndRefunds.ts", "migrations/orders/20261015120002_AddCouponsAndRefunds.ts"]);
    const empty = await addMigration(root, "Nothing", at(3));
    expect(empty.migrations.map((migration) => migration.file)).toEqual(["migrations/20261015120003_Nothing.ts"]);
  });

  test("memory databases are skipped and named, and migration add prints one line per database", async () => {
    const root = project({ "entities/catalog/Product.ts": "export type Product = { name: string };\n" }, ", catalog: memoryAdapter()");
    const result = await cli(root, ["migration", "add", "Init"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["default: migrations/" + migrationFiles(root, "migrations")[0], "orders: migrations/orders/" + migrationFiles(root, "migrations/orders")[0], "Skipped catalog: memory databases keep no schema"]);
    expect(existsSync(join(root, "migrations/catalog"))).toBe(false);
  });
});

describe("migrate", () => {
  test("applies every database with its own control table, or one with --database, and a failure names the database", async () => {
    const root = project();
    await addMigration(root, "Init", at(0));
    const only = await migrate(root, { database: "orders" });
    expect(only.items).toEqual([{ database: "orders", id: "20261015120000_Init", direction: "up" }]);
    expect(tables(root, "orders.db")).toContain(HISTORY_TABLE);
    expect(tables(root, "main.db")).not.toContain(HISTORY_TABLE);
    const all = await migrate(root);
    expect(all.messages).toEqual(["default: Applied 20261015120000_Init", "orders: Database is up to date (0 migrations applied)"]);
    expect(tables(root, "main.db")).toEqual(expect.arrayContaining([HISTORY_TABLE, "customers"]));
    expect(tables(root, "orders.db")).toEqual(expect.arrayContaining([HISTORY_TABLE, "orders__orders"]));
    writeFileSync(join(root, "migrations/orders/20261015120001_Broken.ts"), 'export async function up(ctx: { sql(text: string): Promise<void> }) { await ctx.sql("NOT SQL"); }\nexport async function down() {}\n');
    const failed = await cli(root, ["migrate"]);
    expect(failed.code).toBe(1);
    expect(failed.err.join("\n")).toContain("Migration 20261015120001_Broken failed in database orders");
  });

  test("a target in several folders needs --database", async () => {
    const root = project();
    await addMigration(root, "Init", at(0));
    await expect(migrate(root, { target: "Init" })).rejects.toThrow("Migration target Init exists in databases default, orders; pass --database <name>");
    expect((await migrate(root, { target: "Init", database: "orders" })).items.map((item) => item.database)).toEqual(["orders"]);
  });
});

describe("listing and build messages", () => {
  test("migration list groups by database and --json names it", async () => {
    const root = project();
    await addMigration(root, "Init", at(0));
    await migrate(root, { database: "orders" });
    expect((await listMigrationStatus(root)).entries).toEqual([
      { id: "20261015120000_Init", status: "pending", database: "default" },
      // The orders folder holds entities of the explicit schema orders, whose statements are counted per schema.
      { id: "20261015120000_Init", status: "applied", database: "orders", schemas: [{ schema: "orders", tenants: 1 }] },
    ]);
    const text = await cli(root, ["migration", "list"]);
    expect(text.out).toEqual(["default:", "  20261015120000_Init  pending", "orders:", "  20261015120000_Init  applied  orders: 1 tenant"]);
    const json = JSON.parse((await cli(root, ["migration", "list", "--json"])).out[0]!) as { migrations: { database: string }[] };
    expect(json.migrations.map((migration) => migration.database)).toEqual(["default", "orders"]);
  });

  test("the build names the databases with pending changes", async () => {
    const root = project();
    await addMigration(root, "Init", at(0));
    writeFileSync(join(root, "entities/orders/Order.ts"), "export type Order = { number: string; note?: string };\n");
    const summary = await build(root, {});
    expect(summary.warnings).toContain('Model has changes without a migration in orders. Run "quickservicets migration add <Name>"');
  });
});

describe("moving an entity between databases", () => {
  test("drops it with a warning in the old folder, creates it in the new one, and the build says data is not copied", async () => {
    const root = project({ "entities/Note.ts": "export type Note = { text: string };\n" });
    await addMigration(root, "Init", at(0));
    writeFileSync(join(root, "entities/Note.ts"), "/** @database orders */\nexport type Note = { text: string };\n");
    const summary = await build(root, {});
    expect(summary.warnings).toContain("Moving Note from default to orders does not copy its data");
    const moved = await addMigration(root, "MoveNotes", at(1));
    const [dropped, createdIn] = moved.migrations;
    expect(dropped).toMatchObject({ database: "default" });
    expect(readFileSync(join(root, dropped!.file), "utf8")).toMatch(/\/\/ WARNING: possible data loss\n\s+await ctx\.sql\("DROP TABLE `(\{\{default_schema\}\})?notes`/);
    expect(createdIn).toMatchObject({ database: "orders" });
    expect(readFileSync(join(root, createdIn!.file), "utf8")).toMatch(/CREATE TABLE `(\{\{default_schema\}\})?notes`/);
  });
});
