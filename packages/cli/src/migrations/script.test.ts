import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { run } from "../run.ts";
import { addMigration } from "./add.ts";
import { migrationScript } from "./script.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));

async function project() {
  const root = createLinkedProject({
    "quickservicets.config.ts":
      'import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ":memory:" }) });\n',
    "entities/User.ts": "export type User = { email: string }",
  });
  await addMigration(root, "Initial", at(0));
  writeFileSync(join(root, "entities/User.ts"), "export type User = { email: string; age?: number }");
  await addMigration(root, "AddAge", at(1));
  return root;
}

describe("ranges", () => {
  test("defaults to every up with history inserts", async () => {
    const script = await migrationScript(await project());
    expect(script).toContain("-- 20261015120000_Initial (up)\nCREATE TABLE `users`");
    expect(script).toContain("-- 20261015120001_AddAge (up)\nALTER TABLE `users` ADD `age` real;");
    expect(script).toContain("insert into __quickservicets_migrations (id, name, applied_at) values ('20261015120001_AddAge', 'AddAge'");
    expect(script.indexOf("Initial (up)")).toBeLessThan(script.indexOf("AddAge (up)"));
  });
  test("backwards ranges use down newest first with history deletes", async () => {
    const script = await migrationScript(await project(), { from: "AddAge", to: "0" });
    expect(script.indexOf("AddAge (down)")).toBeLessThan(script.indexOf("Initial (down)"));
    expect(script).toContain("ALTER TABLE `users` DROP COLUMN `age`;");
    expect(script).toContain("delete from __quickservicets_migrations where id = '20261015120001_AddAge';");
  });
  test("a range between two migrations", async () => {
    const script = await migrationScript(await project(), { from: "Initial", to: "20261015120001_AddAge" });
    expect(script).not.toContain("Initial (up)");
    expect(script).toContain("AddAge (up)");
  });
});

test("custom code is marked as not scriptable and tagged values are inlined", async () => {
  const root = await project();
  writeFileSync(
    join(root, "migrations/20261015120002_Backfill.ts"),
    `export async function up(ctx) {
  await ctx.sql\`update users set email = \${"o'neil@x.co"} where age > \${3}\`;
  await ctx.repos.users.list({});
  await ctx.db.select();
}
export async function down() {}
`,
  );
  const script = await migrationScript(root, { from: "AddAge" });
  expect(script).toContain("update users set email = 'o''neil@x.co' where age > 3;");
  expect(script.match(/-- custom code in 20261015120002_Backfill, not scriptable/g)).toHaveLength(1);
});

test("output goes to stdout or to --output", async () => {
  const root = await project();
  const logs: string[] = [];
  expect(await run(["migration", "script", "0", "Initial"], { log: (line) => logs.push(line), error: () => {} }, root)).toBe(0);
  expect(logs.join("\n")).toContain("CREATE TABLE `users`");
  const quiet: string[] = [];
  expect(await run(["migration", "script", "--output", "out.sql"], { log: (line) => quiet.push(line), error: () => {} }, root)).toBe(0);
  expect(quiet).toEqual([]);
  expect(readFileSync(join(root, "out.sql"), "utf8")).toContain("AddAge (up)");
});

test("unknown points are named", async () => {
  const errors: string[] = [];
  expect(await run(["migration", "script", "Nope"], { log: () => {}, error: (line) => errors.push(line) }, await project())).toBe(1);
  expect(errors).toEqual(["Unknown migration: Nope"]);
});
