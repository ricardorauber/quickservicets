import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { run } from "../run.ts";
import { addMigration } from "./add.ts";
import { listMigrationStatus, removeLatestMigration } from "./list-remove.ts";
import { migrate } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));

function project(databasePath?: string) {
  const root = createLinkedProject({ "entities/User.ts": "export type User = { email: string }" });
  const path = databasePath ?? join(root, "app.db");
  writeFileSync(
    join(root, "quickservicets.config.ts"),
    `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }) });\n`,
  );
  return root;
}

async function twoMigrations(root: string) {
  await addMigration(root, "Initial", at(0));
  writeFileSync(join(root, "entities/User.ts"), "export type User = { email: string; age?: number }");
  await addMigration(root, "AddAge", at(1));
}

describe("list", () => {
  test("applied and pending, in id order", async () => {
    const root = project();
    await twoMigrations(root);
    await migrate(root, { target: "Initial" });
    expect((await listMigrationStatus(root)).entries).toEqual([
      { id: "20261015120000_Initial", status: "applied" },
      { id: "20261015120001_AddAge", status: "pending" },
    ]);
  });

  test("applied migrations missing on disk", async () => {
    const root = project();
    await twoMigrations(root);
    await migrate(root);
    rmSync(join(root, "migrations/20261015120001_AddAge.ts"));
    expect((await listMigrationStatus(root)).entries).toContainEqual({ id: "20261015120001_AddAge", status: "missing" });
  });

  test("an unreachable database yields unknown statuses and a warning", async () => {
    const root = project("/nonexistent-dir/for/quickservicets/app.db");
    await twoMigrations(root);
    const errors: string[] = [];
    const logs: string[] = [];
    expect(await run(["migration", "list"], { log: (line) => logs.push(line), error: (line) => errors.push(line) }, root)).toBe(0);
    expect(logs).toEqual(["20261015120000_Initial  unknown", "20261015120001_AddAge  unknown"]);
    expect(errors[0]).toStartWith("Warning: Could not reach the database");
  });
});

describe("remove", () => {
  test("deletes the newest file and snapshot so the previous snapshot is the latest", async () => {
    const root = project();
    await twoMigrations(root);
    const original = readFileSync(join(root, "migrations/20261015120001_AddAge.ts"), "utf8");
    expect(await removeLatestMigration(root)).toEqual([
      "migrations/20261015120001_AddAge.ts",
      "migrations/meta/20261015120001_AddAge.snapshot.json",
    ]);
    expect(existsSync(join(root, "migrations/20261015120001_AddAge.ts"))).toBe(false);
    const recreated = await addMigration(root, "AddAge", at(1));
    expect(readFileSync(join(root, recreated.file), "utf8")).toBe(original);
  });

  test("refuses when the newest migration is applied", async () => {
    const root = project();
    await twoMigrations(root);
    await migrate(root);
    const errors: string[] = [];
    expect(await run(["migration", "remove"], { log: () => {}, error: (line) => errors.push(line) }, root)).toBe(1);
    expect(errors).toEqual([
      'Migration 20261015120001_AddAge is applied. Revert it with "quickservicets migrate Initial" first',
    ]);
  });

  test("an empty project has nothing to remove", async () => {
    const errors: string[] = [];
    expect(await run(["migration", "remove"], { log: () => {}, error: (line) => errors.push(line) }, project())).toBe(1);
    expect(errors).toEqual(["No migrations to remove"]);
  });
});
