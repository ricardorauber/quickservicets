import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { addMigration } from "../migrations/add.ts";
import { build } from "./build.ts";
import { startTestService } from "../testing/service.ts";

const config = (database: string) => `import { defineConfig, ${database === "sqlite" ? "sqliteAdapter" : "memoryAdapter"} } from "@quickservicets/core";
export default defineConfig({ database: ${database === "sqlite" ? 'sqliteAdapter({ path: ":memory:" })' : "memoryAdapter()"}, metrics: { store: "database" } });
`;

test("the database store adds metric_windows to migrations, no routes, and the metrics/rollup job", async () => {
  const root = createLinkedProject({ "quickservicets.config.ts": config("sqlite"), "entities/Post.ts": "export type Post = { title: string };\n" });
  const created = await addMigration(root, "Initial", new Date(Date.UTC(2026, 9, 28, 10)));
  const source = readFileSync(join(root, created.file), "utf8");
  expect(source).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?metric_windows/);
  await build(root, {});
  expect(readFileSync(join(root, ".generated/jobs.ts"), "utf8")).toContain("metrics/rollup");

  const service = await startTestService({ files: { "quickservicets.config.ts": config("memory"), "entities/Post.ts": "export type Post = { title: string };\n" } });
  try {
    expect((await service.fetch("/metric-windows")).status).toBe(404);
    expect((await service.fetch("/posts")).status).toBe(200);
  } finally {
    await service.stop();
  }
});
