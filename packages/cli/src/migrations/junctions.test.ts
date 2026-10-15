import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDrizzleSchema } from "@quickservice/core";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { parseEntities } from "../entities/parse-entities.ts";
import { createLinkedProject, createProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";

const files = (onDelete = "") => ({
  "entities/User.ts": "export type User = { name: string }",
  "entities/Organization.ts": `import type { User } from "./User";\nexport type Organization = { name: string; ${onDelete} members: User[] }`,
});

describe("junction tables", () => {
  test.each([
    ["", "cascade"],
    ["/** @onDelete restrict */", "restrict"],
    ["/** @onDelete cascade */", "restrict"],
  ])("%s → target foreign key %s", (tag, action) => {
    const models = parseEntities(createProject(files(tag)));
    const junction = buildDrizzleSchema(models, "sqlite").junctions["Organization.members"]!;
    const config = getTableConfig(junction as never);
    expect(config.name).toBe("organizations__members");
    expect(config.columns.map((column) => column.name).sort()).toEqual(["owner_id", "position", "target_id"]);
    expect(config.primaryKeys[0]!.columns.map((column) => column.name)).toEqual(["owner_id", "target_id"]);
    expect(config.indexes.map((index) => index.config.name)).toEqual(["organizations__members_target_idx"]);
    const [owner, target] = config.foreignKeys.map((key) => key.onDelete);
    expect(owner).toBe("cascade");
    expect(target).toBe(action as never);
  });

  test("migrations create junction tables in up and drop them in down", async () => {
    const root = createLinkedProject({
      ...files(),
      "quickservice.config.ts": 'import { defineConfig, sqliteAdapter } from "@quickservice/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ":memory:" }) });\n',
    });
    const source = readFileSync(join(root, (await addMigration(root, "Initial")).file), "utf8");
    const [up, down] = source.split("export async function down");
    expect(up).toContain("CREATE TABLE `{{default_schema}}organizations__members`");
    expect(up).toContain("organizations__members_target_idx");
    expect(down).toContain("DROP TABLE `{{default_schema}}organizations__members`");
  });
});
