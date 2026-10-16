import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { parseEntities, parseProjectEntities } from "../entities/parse-entities.ts";
import { run } from "../run.ts";
import { build } from "../build/build.ts";
import { addAutomaticMigration, addMigration, hasPendingChanges } from "./add.ts";
import { suggestMigrationName } from "./naming.ts";

const config = (adapter: "sqlite" | "postgres") =>
  adapter === "sqlite"
    ? 'import { defineConfig, sqliteAdapter } from "@quickservice/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ":memory:" }) });\n'
    : 'import { defineConfig, postgresAdapter } from "@quickservice/core";\nexport default defineConfig({ database: postgresAdapter({ url: "postgres://localhost/none" }) });\n';

const project = (adapter: "sqlite" | "postgres" = "sqlite") =>
  createLinkedProject({
    "quickservice.config.ts": config(adapter),
    "entities/User.ts": "export type User = { email: string }",
  });
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const setUser = (root: string, body: string) => writeFileSync(join(root, "entities/User.ts"), `export type User = ${body}`);

describe.each(["sqlite", "postgres"] as const)("%s", (adapter) => {
  test("creates the file with up/down and its snapshot", async () => {
    const root = project(adapter);
    const created = await addMigration(root, "Initial", at(0));
    expect(created.file).toBe("migrations/20261015120000_Initial.ts");
    expect(existsSync(join(root, "migrations/meta/20261015120000_Initial.snapshot.json"))).toBe(true);
    const source = read(root, created.file);
    expect(source).toContain("export async function up(ctx: MigrationContext)");
    expect(source).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?users/);
    expect(source).toMatch(/DROP TABLE \\?[`"](\{\{default_schema\}\})?users/);
  });
});

describe("up and down SQL", () => {
  test("add column, and drop it in down with a data-loss warning", async () => {
    const root = project();
    await addMigration(root, "Initial", at(0));
    setUser(root, "{ email: string; age?: number }");
    const source = read(root, (await addMigration(root, "AddAge", at(1))).file);
    const [up, down] = source.split("export async function down");
    expect(up).toContain("ADD `age` real");
    expect(up).toContain("ALTER TABLE `{{default_schema}}users`");
    expect(down).toContain("// WARNING: possible data loss\n  await ctx.sql(\"ALTER TABLE `{{default_schema}}users` DROP COLUMN `age`;\");");
  });

  test("dropping a column warns in up", async () => {
    const root = project();
    setUser(root, "{ email: string; age?: number }");
    await addMigration(root, "Initial", at(0));
    setUser(root, "{ email: string }");
    const [up] = read(root, (await addMigration(root, "RemoveAge", at(1))).file).split("export async function down");
    expect(up).toContain("// WARNING: possible data loss");
    expect(up).toContain("DROP COLUMN `age`");
  });

  test("renames never prompt and become drop + add", async () => {
    const root = project("postgres");
    setUser(root, "{ email: string; old?: string }");
    await addMigration(root, "Initial", at(0));
    setUser(root, "{ email: string; fresh?: number }");
    const source = read(root, (await addMigration(root, "Rename", at(1))).file);
    expect(source).toContain('DROP COLUMN \\"old\\"');
    expect(source).toContain('ADD COLUMN \\"fresh\\" double precision');
  });

  test("altering a column type is generated in both directions", async () => {
    const root = project("postgres");
    setUser(root, "{ email: string; age?: number }");
    await addMigration(root, "Initial", at(0));
    setUser(root, "{ email: string; age?: string }");
    const source = read(root, (await addMigration(root, "AlterAge", at(1))).file);
    expect(source).toContain('SET DATA TYPE text');
    expect(source).toContain('SET DATA TYPE double precision');
  });
});

describe("names", () => {
  test("must be PascalCase and unique", async () => {
    const root = project();
    await addMigration(root, "AddAge", at(0));
    await expect(addMigration(root, "AddAge", at(1))).rejects.toThrow("20261015120000_AddAge");
    await expect(addMigration(root, "addAge", at(2))).rejects.toThrow("PascalCase");
  });
  test("ids stay increasing within the same second", async () => {
    const root = project();
    await addMigration(root, "First", at(5));
    const second = await addMigration(root, "Second", at(5));
    expect(second.file).toBe("migrations/20261015120006_Second.ts");
  });
});

test("an empty migration is created when nothing changed", async () => {
  const root = project();
  await addMigration(root, "Initial", at(0));
  const source = read(root, (await addMigration(root, "BackfillSlugs", at(1))).file);
  expect(source).toContain("export async function up(ctx: MigrationContext): Promise<void> {\n\n}");
  expect(source).toContain("export async function down(ctx: MigrationContext): Promise<void> {\n\n}");
});

describe("name suggestions and pending changes", () => {
  test("suggestions describe the change", async () => {
    const root = project();
    const before = parseEntities(root);
    setUser(root, "{ email: string; age?: number }");
    expect(suggestMigrationName(before, parseEntities(root))).toBe("AddAgeToUsers");
    expect(suggestMigrationName([], parseEntities(root))).toBe("CreateUser");
    writeFileSync(join(root, "entities/Post.ts"), "export type Post = { title: string }");
    expect(suggestMigrationName(before, parseEntities(root))).toBe("UpdateModel");
    expect(suggestMigrationName(parseEntities(root), before)).toBe("UpdateModel");
  });

  test("pending changes follow the latest snapshot", async () => {
    const root = project();
    expect(await hasPendingChanges(root, parseProjectEntities(root), "sqlite")).toBe(true);
    await addMigration(root, "Initial", at(0));
    expect(await hasPendingChanges(root, parseProjectEntities(root), "sqlite")).toBe(false);
    setUser(root, "{ email: string; age?: number }");
    expect(await hasPendingChanges(root, parseProjectEntities(root), "sqlite")).toBe(true);
  });

  test("automatic migrations are named after the change", async () => {
    const root = project();
    await addMigration(root, "Initial", at(0));
    expect(await addAutomaticMigration(root, at(1))).toBeUndefined();
    setUser(root, "{ email: string; age?: number }");
    expect((await addAutomaticMigration(root, at(2)))?.file).toBe("migrations/20261015120002_AddAgeToUsers.ts");
  });

  test("build warns without creating migrations", async () => {
    const root = project();
    const errors: string[] = [];
    expect(await run(["build"], { log: () => {}, error: (line) => errors.push(line) }, root)).toBe(0);
    expect(errors).toEqual(['Warning: Model has changes without a migration. Run "quickservice migration add <Name>"']);
    expect(existsSync(join(root, "migrations"))).toBe(false);
    await addMigration(root, "Initial", at(0));
    expect((await build(root)).warnings).toEqual([]);
  });
});

test("the memory adapter has no migrations", async () => {
  const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "entities/User.ts": "export type User = { email: string }" });
  const errors: string[] = [];
  expect(await run(["migration", "add", "Initial"], { log: () => {}, error: (line) => errors.push(line) }, root)).toBe(1);
  expect(errors).toEqual(["Migrations are not used with the memory adapter"]);
  expect(existsSync(join(root, "migrations"))).toBe(false);
});

test("migration files are valid TypeScript modules", async () => {
  const root = project();
  await addMigration(root, "Initial", at(0));
  const file = readdirSync(join(root, "migrations")).find((entry) => entry.endsWith(".ts"))!;
  const module = await import(join(root, "migrations", file));
  const statements: string[] = [];
  await module.up({ sql: async (query: string) => statements.push(query), db: undefined, repos: {} });
  expect(statements.join("\n")).toContain("CREATE TABLE `{{default_schema}}users`");
});
