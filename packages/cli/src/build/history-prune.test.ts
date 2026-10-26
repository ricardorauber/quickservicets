import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sqliteAdapter, type EntityModel, type StoredRecord } from "@quickservice/core";
import { build } from "./build.ts";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";

const DAY = 86_400_000;
const config = (path: string, history: string) =>
  `import { defineConfig, sqliteAdapter } from "@quickservice/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }), events: {}, history: ${history}, logger: { info() {}, warn() {}, error() {} } });\n`;

/** A migrated SQLite project with two history entities, a way to store old versions and to run the CLI. */
async function sqliteProject(history: string) {
  const root = createLinkedProject({
    "quickservice.config.ts": "",
    "entities/User.ts": "/** @history */\nexport type User = { name: string };\n",
    "entities/Session.ts": "/** @history */\nexport type Session = { token: string };\n",
  });
  const path = join(root, "data.db");
  writeFileSync(join(root, "quickservice.config.ts"), config(path, history));
  await build(root);
  await addMigration(root, "Initial", new Date(Date.UTC(2026, 9, 15, 12)));
  await migrate(root);
  const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
  const withAdapter = async <T>(fn: (adapter: ReturnType<typeof sqliteAdapter>) => Promise<T>) => {
    const adapter = sqliteAdapter({ path });
    await adapter.connect(models);
    try {
      return await fn(adapter);
    } finally {
      await adapter.disconnect();
    }
  };
  const modelOf = (key: string) => models.find((model) => model.key === key)!;
  const insert = (key: string, entityId: string, version: number, operation: string, ageDays: number) =>
    withAdapter(async (adapter) => {
      const at = new Date(Date.now() - ageDays * DAY);
      await adapter.insert(modelOf(key), { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, entityId, version, operation, actor: "system", at, record: {}, changed: [] } as StoredRecord);
    });
  const count = (key: string) => withAdapter((adapter) => adapter.count(modelOf(key), []));
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
    return { code, out, err };
  };
  return { root, insert, count, cli };
}

describe("history prune", () => {
  test("without a retention it deletes nothing and says so", async () => {
    const { insert, count, cli } = await sqliteProject("{}");
    await insert("UserHistory", "a", 1, "create", 3650);
    await insert("UserHistory", "a", 2, "update", 3650);
    expect(await cli("history", "prune")).toEqual({ code: 0, out: ["No retention configured; nothing to prune"], err: [] });
    expect(await count("UserHistory")).toBe(2);
  });

  test("prunes per entity, with --dry-run and --entity, and fails for an unknown entity", async () => {
    const { insert, count, cli } = await sqliteProject('{ retention: "30d" }');
    await insert("UserHistory", "a", 1, "create", 40);
    await insert("UserHistory", "a", 2, "update", 40);
    await insert("UserHistory", "a", 3, "update", 20);
    await insert("SessionHistory", "s", 1, "create", 40);
    await insert("SessionHistory", "s", 2, "delete", 40);
    expect(await cli("history", "prune", "--dry-run")).toEqual({ code: 0, out: ["Session: 2 versions would be deleted", "User: 2 versions would be deleted"], err: [] });
    expect([await count("UserHistory"), await count("SessionHistory")]).toEqual([3, 2]);
    expect(await cli("history", "prune", "--entity", "User")).toEqual({ code: 0, out: ["User: 2 versions deleted"], err: [] });
    expect([await count("UserHistory"), await count("SessionHistory")]).toEqual([1, 2]);
    expect(await cli("history", "prune", "--entity", "Nope")).toEqual({ code: 1, out: [], err: ["Unknown history entity Nope"] });
    expect(await cli("history", "prune")).toEqual({ code: 0, out: ["Session: 2 versions deleted", "User: 0 versions deleted"], err: [] });
  });

  test("job list shows history/prune daily, help lists the command, and the reference page lists both", async () => {
    const { cli } = await sqliteProject("{}");
    const jobs = await cli("job", "list");
    expect(jobs.out.some((line) => /^history\/prune +@daily /.test(line))).toBe(true);
    const help = (await cli("help")).out.join("\n");
    expect(help.slice(help.indexOf("history:"))).toContain("history prune");
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/history.mdx"), "utf8");
    expect(page).toContain("quickservice history prune [--entity <Name>] [--dry-run]");
    expect(page).toContain("history/prune");
  });
});
