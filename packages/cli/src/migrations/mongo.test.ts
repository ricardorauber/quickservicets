import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { createLinkedProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";
import { listMigrationStatus } from "./list-remove.ts";
import { migrate, MONGO_NO_TRANSACTION_WARNING } from "./migrate.ts";
import { planMongoMigration } from "./mongo.ts";
import { migrationScript } from "./script.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));
const url = process.env.TEST_MONGODB_URL;

function project(database = `ss_mig_${Bun.randomUUIDv7().replaceAll("-", "")}`, mongoUrl = url ?? "mongodb://127.0.0.1:1") {
  const root = createLinkedProject({
    "quickservice.config.ts": `import { defineConfig, mongodbAdapter } from "@quickservice/core";\nexport default defineConfig({ database: mongodbAdapter({ url: ${JSON.stringify(mongoUrl)}, database: ${JSON.stringify(database)} }) });\n`,
    "entities/User.ts": "export type User = { /** @unique */ email: string }",
  });
  return { root, database };
}

describe("generation", () => {
  test("index diffs become up and down", async () => {
    const { root } = project();
    const source = readFileSync(join(root, (await addMigration(root, "Initial", at(0))).file), "utf8");
    const [up, down] = source.split("export async function down");
    expect(up).toContain('await ctx.db().collection("users").createIndex({"email":1}, {"name":"users_email_uq","unique":true');
    expect(up).toContain('createIndex({"createdAt":1}, {"name":"users_created_at_idx"})');
    expect(down).toContain('await ctx.db().collection("users").dropIndex("users_email_uq");');
    expect(source).toContain("import type { MongoMigrationContext }");
  });

  test("removing an entity keeps its collection with a TODO", async () => {
    const { root } = project();
    writeFileSync(join(root, "entities/Post.ts"), "export type Post = { title: string }");
    await addMigration(root, "Initial", at(0));
    Bun.spawnSync(["rm", join(root, "entities/Post.ts")]);
    const plan = planMongoMigration(root, [(await import("../entities/parse-entities.ts")).parseEntities(root)[0]!]);
    expect(plan.up[0]).toBe("// TODO: data in collection posts is kept; drop it here if intended");
    expect(plan.up.join("\n")).not.toContain("drop()");
  });

  test("script renders index operations as mongosh commands", async () => {
    const { root } = project();
    await addMigration(root, "Initial", at(0));
    writeFileSync(
      join(root, "migrations/20261015120001_Backfill.ts"),
      'export async function up(ctx) { await ctx.db().collection("users").updateMany({}, {}); }\nexport async function down() {}\n',
    );
    const script = await migrationScript(root);
    expect(script).toContain('db.users.createIndex({"email":1}, {"name":"users_email_uq"');
    expect(script).toContain('db._migrations.insertOne({ _id: "20261015120000_Initial"');
    expect(script).toContain("// custom code in 20261015120001_Backfill, not scriptable");
  });
});

if (url) {
  describe("running against MongoDB", () => {
    test("migrate applies and reverts index migrations with history in _migrations", async () => {
      const { root, database } = project();
      await addMigration(root, "Initial", at(0));
      const result = await migrate(root);
      expect(result.applied).toEqual(["20261015120000_Initial"]);
      expect(result.warnings).toEqual([MONGO_NO_TRANSACTION_WARNING]);
      const client = new MongoClient(url);
      await client.connect();
      const db = client.db(database);
      expect((await db.collection("users").indexes()).map((index) => index.name).sort()).toEqual([
        "_id_",
        "users_created_at_idx",
        "users_email_uq",
      ]);
      expect(await db.collection("_migrations").countDocuments()).toBe(1);
      expect((await listMigrationStatus(root)).entries).toEqual([{ id: "20261015120000_Initial", status: "applied" }]);
      expect((await migrate(root, { target: "0" })).reverted).toEqual(["20261015120000_Initial"]);
      expect((await db.collection("users").indexes()).map((index) => index.name)).toEqual(["_id_"]);
      expect(await db.collection("_migrations").countDocuments()).toBe(0);
      await db.dropDatabase();
      await client.close();
    });

    test("hand-written data changes run through ctx.db()", async () => {
      const { root, database } = project();
      await addMigration(root, "Initial", at(0));
      writeFileSync(
        join(root, "migrations/20261015120001_Seed.ts"),
        'export async function up(ctx) { await ctx.db().collection("users").insertOne({ _id: "seed", email: "s@x.co" }); }\nexport async function down(ctx) { await ctx.db().collection("users").deleteOne({ _id: "seed" }); }\n',
      );
      await migrate(root);
      const client = new MongoClient(url);
      await client.connect();
      expect(await client.db(database).collection("users").countDocuments({ _id: "seed" as never })).toBe(1);
      await client.db(database).dropDatabase();
      await client.close();
    });
  });
} else {
  test.skip("MongoDB migrations against a server (set TEST_MONGODB_URL to run)", () => {});
}
