import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { createLinkedProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";
import { migrate } from "./migrate.ts";
import { migrationScript } from "./script.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const suffix = () => Bun.randomUUIDv7().replaceAll("-", "").slice(-12);
const url = process.env.TEST_MONGODB_URL;

function project(schema: string, database: string, mongoUrl = url ?? "mongodb://127.0.0.1:1") {
  return createLinkedProject({
    "quickservice.config.ts": `import { defineConfig, mongodbAdapter } from "@quickservice/core";\nexport default defineConfig({ database: mongodbAdapter({ url: ${JSON.stringify(mongoUrl)}, database: ${JSON.stringify(database)} }) });\n`,
    "entities/User.ts": "export type User = { /** @unique */ email: string }",
    [`entities/${schema}/Account.ts`]: "export type Account = { /** @unique */ email: string }",
  });
}

test("generated index operations target each entity's schema database", async () => {
  const schema = `auth${suffix()}`;
  const root = project(schema, "x");
  const source = readFileSync(join(root, (await addMigration(root, "Initial", at(0))).file), "utf8");
  expect(source).toContain(`await ctx.db(${JSON.stringify(schema)}).collection("accounts").createIndex(`);
  expect(source).toContain('await ctx.db().collection("users").createIndex(');
  expect(await migrationScript(root)).toContain(`db.getSiblingDB(${JSON.stringify(schema)}).accounts.createIndex(`);
});

if (url) {
  test("migrate creates indexes in every schema database and ctx.db(schema) reaches it", async () => {
    const schema = `auth${suffix()}`;
    const database = `default_${suffix()}`;
    const root = project(schema, database);
    await addMigration(root, "Initial", at(0));
    writeFileSync(
      join(root, "migrations/20261015120001_Seed.ts"),
      `export async function up(ctx) { await ctx.db(${JSON.stringify(schema)}).collection("accounts").insertOne({ _id: "seed", email: "s@x.co" }); }\nexport async function down() {}\n`,
    );
    await migrate(root);
    const client = new MongoClient(url);
    await client.connect();
    try {
      expect((await client.db(schema).collection("accounts").indexes()).map((index) => index.name)).toContain("accounts_email_uq");
      expect((await client.db(database).collection("users").indexes()).map((index) => index.name)).toContain("users_email_uq");
      expect(await client.db(schema).collection("accounts").countDocuments({ _id: "seed" as never })).toBe(1);
      expect(await client.db(database).collection("_migrations").countDocuments()).toBe(2);
    } finally {
      await client.db(schema).dropDatabase();
      await client.db(database).dropDatabase();
      await client.close();
    }
  });
} else {
  test.skip("MongoDB schema migrations (set TEST_MONGODB_URL to run)", () => {});
}
