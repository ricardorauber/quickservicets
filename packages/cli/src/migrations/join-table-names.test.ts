import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { buildDrizzleSchema, createRepositories, mongodbAdapter, type Repository } from "@quickservicets/core";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { joinTableWarnings } from "../build/build.ts";
import { parseEntities } from "../entities/parse-entities.ts";
import { createLinkedProject, createProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";
import { migrate } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const nn = (organization = "users?: User[]", user = "organizations?: Organization[]") => ({
  "entities/Organization.ts": `import type { User } from "./User";\nexport type Organization = { name: string; ${organization} }`,
  "entities/User.ts": `import type { Organization } from "./Organization";\nexport type User = { name: string; ${user} }`,
});
const parse = (files: Record<string, string>) => parseEntities(createProject(files));
const failure = (files: Record<string, string>) => {
  try {
    parse(files);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};
const linkOf = (files: Record<string, string>) => parse(files).find((model) => model.link)!;

test("a reference array uses its @joinTable name", () => {
  const models = parse({
    "entities/User.ts": "export type User = { name: string }",
    "entities/Organization.ts": 'import type { User } from "./User";\nexport type Organization = { /** @joinTable organization_members */ members?: User[] }',
  });
  expect(getTableConfig(buildDrizzleSchema(models, "sqlite").junctions["Organization.members"] as never).name).toBe("organization_members");
});

describe("N-N relations", () => {
  test("default name follows the alphabetically first entity", () => {
    expect(linkOf(nn()).tableName).toBe("organizations__users");
  });
  test("both sides must agree", () => {
    const message = failure(nn("/** @joinTable memberships */ users?: User[]", "/** @joinTable members */ organizations?: Organization[]"));
    expect(message).toContain("Organization.users");
    expect(message).toContain("User.organizations");
    expect(linkOf(nn("/** @joinTable memberships */ users?: User[]", "/** @joinTable memberships */ organizations?: Organization[]")).tableName).toBe("memberships");
  });
});

describe("invalid uses", () => {
  test("on a single reference", () => {
    expect(failure(nn("", "/** @joinTable x */ organization?: Organization"))).toContain("@joinTable");
  });
  test("on a 1-N relation", () => {
    expect(failure(nn("/** @joinTable x */ users?: User[]", "organization?: Organization"))).toContain("1-N relations have no join table");
  });
  test("with an invalid name", () => {
    expect(failure(nn("/** @joinTable Members */ users?: User[]"))).toContain("@joinTable");
  });
  test("colliding with an entity table names both sources", () => {
    const message = failure(nn("/** @joinTable users */ users?: User[]"));
    expect(message).toContain("entities/User.ts");
    expect(message).toContain('field "users"');
  });
});

test("MongoDB and memory ignore @joinTable on unpaired arrays with a warning", () => {
  const models = parse({
    "entities/Tag.ts": "export type Tag = { label: string }",
    "entities/Post.ts": 'import type { Tag } from "./Tag";\nexport type Post = { /** @joinTable post_tags */ tags?: Tag[] }',
  });
  expect(joinTableWarnings(models, "mongodb")).toEqual(['entities/Post.ts: @joinTable on field "tags" is ignored on mongodb (reference arrays are embedded)']);
  expect(joinTableWarnings(models, "sqlite")).toEqual([]);
});

if (process.env.TEST_MONGODB_URL) {
  test("MongoDB stores N-N links in the named join collection", async () => {
    const models = parse(nn("/** @joinTable memberships */ users?: User[]"));
    const database = `ss_join_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const adapter = mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database });
    await adapter.connect(models);
    for (const model of models) await adapter.createIndexes(model);
    const repos = createRepositories(models, adapter) as Record<string, Repository>;
    const org = await repos.organizations!.create({ name: "o" });
    await repos.users!.create({ name: "u", organizations: [org.id] });
    expect(await adapter.db!.collection("memberships").countDocuments()).toBe(1);
    await adapter.db!.dropDatabase();
    await adapter.disconnect();
  });
} else {
  test.skip("MongoDB join collections (set TEST_MONGODB_URL to run)", () => {});
}

describe("renames in migrations", () => {
  test("SQLite renames the table and keeps the links", async () => {
    const path = join(createProject({}), "app.db");
    const root = createLinkedProject({
      ...nn("/** @joinTable memberships */ users?: User[]"),
      "quickservicets.config.ts": `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(path)} }) });\n`,
    });
    await addMigration(root, "Initial", at(0));
    await migrate(root);
    const database = new Database(path);
    database.run("insert into organizations (id, created_at, updated_at, name) values ('o', 0, 0, 'o')");
    database.run("insert into users (id, created_at, updated_at, name) values ('u', 0, 0, 'u')");
    database.run("insert into memberships (id, created_at, updated_at, left, right, left_position, right_position, pair) values ('l', 0, 0, 'o', 'u', 0, 0, 'o:u')");
    database.close();

    writeFileSync(join(root, "entities/Organization.ts"), 'import type { User } from "./User";\nexport type Organization = { name: string; /** @joinTable organization_users */ users?: User[] }');
    const source = readFileSync(join(root, (await addMigration(root, "RenameMemberships", at(1))).file), "utf8");
    const [up, down] = source.split("export async function down");
    expect(up).toContain("ALTER TABLE `{{default_schema}}memberships` RENAME TO `{{default_schema}}organization_users`;");
    expect(up).not.toContain("DROP TABLE");
    expect(down).toContain("ALTER TABLE `{{default_schema}}organization_users` RENAME TO `{{default_schema}}memberships`;");
    await migrate(root);
    const after = new Database(path);
    expect(after.query("select count(*) as count from organization_users").get()).toEqual({ count: 1 });
    after.close();
    await migrate(root, { target: "Initial" });
    const reverted = new Database(path);
    expect(reverted.query("select count(*) as count from memberships").get()).toEqual({ count: 1 });
    reverted.close();
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  test("PostgreSQL places the join table in the naming entity's schema", async () => {
    const admin = new SQL(postgresUrl);
    await admin.unsafe("drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;");
    await admin.close();
    const root = createLinkedProject({
      "entities/auth/Organization.ts": 'import type { User } from "./User";\nexport type Organization = { name: string; /** @joinTable memberships */ users?: User[] }',
      "entities/auth/User.ts": 'import type { Organization } from "./Organization";\nexport type User = { name: string; organizations?: Organization[] }',
      "quickservicets.config.ts": `import { defineConfig, postgresAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: postgresAdapter({ url: ${JSON.stringify(postgresUrl)} }) });\n`,
    });
    await addMigration(root, "Initial", at(0));
    await migrate(root);
    const check = new SQL(postgresUrl);
    const rows = (await check.unsafe("select table_schema || '.' || table_name as name from information_schema.tables where table_name = 'memberships'")) as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(["auth.memberships"]);
    await check.close();
  });
} else {
  test.skip("PostgreSQL join table schema (set TEST_POSTGRES_URL to run)", () => {});
}

test("MongoDB migrations rename the join collection both ways", async () => {
  const root = createLinkedProject({
    ...nn("/** @joinTable memberships */ users?: User[]"),
    "quickservicets.config.ts": 'import { defineConfig, mongodbAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: mongodbAdapter({ url: "mongodb://127.0.0.1:1", database: "x" }) });\n',
  });
  await addMigration(root, "Initial", at(0));
  writeFileSync(join(root, "entities/Organization.ts"), 'import type { User } from "./User";\nexport type Organization = { name: string; /** @joinTable organization_users */ users?: User[] }');
  const source = readFileSync(join(root, (await addMigration(root, "RenameMemberships", at(1))).file), "utf8");
  const [up, down] = source.split("export async function down");
  expect(up).toContain('await ctx.db().collection("memberships").rename("organization_users");');
  expect(down).toContain('await ctx.db().collection("organization_users").rename("memberships");');
  expect(source).not.toContain("TODO");
});
