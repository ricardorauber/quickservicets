import { describe, expect, spyOn, test } from "bun:test";
import type { EntityModel } from "../model.ts";
import { tablePlans } from "../sql/schema.ts";
import { contractRecord } from "../testing/adapter-contract.ts";
import { entity, field } from "../testing/entities.ts";
import { postgresDdl, recordStatements } from "../testing/postgres.ts";
import { createSqliteTables } from "../testing/sql.ts";
import { memoryAdapter } from "./memory.ts";
import { mongodbAdapter } from "./mongodb.ts";
import { postgresAdapter } from "./postgres.ts";
import { MAX_SCHEMA_VIEWS } from "./schema-views.ts";
import { sqliteAdapter } from "./sqlite.ts";

const post = entity("Post", [field({ name: "title", type: "string" })]);
const user = entity("User", [field({ name: "email", type: "string" })], { schema: "auth", schemaKey: "auth", key: "auth/User", repoKey: "users" });
const models: EntityModel[] = [post, user];
const TENANT = "qs-b08-tenant-a";

describe("placement per database", () => {
  test("SQLite stores a view's default-schema tables with the schema prefix and explicit schemas where they are", async () => {
    const adapter = sqliteAdapter({ path: ":memory:" });
    await adapter.connect(models);
    await createSqliteTables(adapter.client!, models);
    await createSqliteTables(adapter.client!, [post], { defaultSchema: TENANT });
    const view = adapter.withSchema(TENANT);
    const record = await view.insert(post, contractRecord({ title: "in the view" }));
    const shared = await view.insert(user, contractRecord({ email: "a@x.test" }));
    expect(adapter.client!.query(`select title from qs_b08_tenant_a__posts where id = ?`).get(record.id)).toEqual({ title: "in the view" });
    expect(adapter.client!.query(`select count(*) as n from posts`).get()).toEqual({ n: 0 });
    expect(adapter.client!.query(`select email from auth__users where id = ?`).get(shared.id)).toEqual({ email: "a@x.test" });
    await adapter.disconnect();
  });

  test("the memory adapter keeps a namespace per view schema", async () => {
    const adapter = memoryAdapter();
    await adapter.connect(models);
    const record = await adapter.withSchema!(TENANT).insert(post, contractRecord({ title: "a" }));
    expect(await adapter.findById(post, record.id)).toBeNull();
    expect((await adapter.withSchema!(TENANT).findById(post, record.id))?.title).toBe("a");
  });
});

describe("view cache", () => {
  test("one view per schema; invalid names throw; the least recently used idle view is evicted past the limit", async () => {
    const adapter = memoryAdapter();
    await adapter.connect(models);
    expect(() => adapter.withSchema!("Bad")).toThrow('Invalid schema: "Bad" must match ^[a-z][a-z0-9-]*$');
    expect(() => adapter.withSchema!("1a")).toThrow('Invalid schema: "1a" must match ^[a-z][a-z0-9-]*$');
    const first = adapter.withSchema!("a");
    expect(adapter.withSchema!("a")).toBe(first);
    const second = adapter.withSchema!("b");
    // A long transaction keeps the view of `b` busy, so `b` stays even though it was used least recently.
    let release!: () => void;
    const busy = second.transaction(() => new Promise<void>((resolve) => (release = resolve)));
    while (!release) await Bun.sleep(1);
    adapter.withSchema!("a");
    for (let index = 0; index < MAX_SCHEMA_VIEWS - 2; index++) adapter.withSchema!(`s${index}`);
    // The 1001st schema evicts `a`, the least recently used idle view; `b` is older but busy.
    adapter.withSchema!("one-more");
    expect(adapter.withSchema!("b")).toBe(second);
    expect(adapter.withSchema!("a")).not.toBe(first);
    release();
    await busy;
  });
});

describe("plans per view", () => {
  test("the table of Post for a view is built once across 100 reads", async () => {
    const adapter = sqliteAdapter({ path: ":memory:" });
    await adapter.connect(models);
    await createSqliteTables(adapter.client!, [post], { defaultSchema: TENANT });
    const builds = spyOn(tablePlans, "table");
    const view = adapter.withSchema(TENANT);
    const record = await view.insert(post, contractRecord({ title: "a" }));
    for (let index = 0; index < 100; index++) await view.findById(post, record.id);
    expect(builds.mock.calls.filter(([, model]) => model.key === "Post").length).toBe(1);
    builds.mockRestore();
    await adapter.disconnect();
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)("postgres views", () => {
  test("a view's statements name its schema, and the record lands in that schema's table", async () => {
    const adapter = postgresAdapter({ url: postgresUrl! });
    await adapter.connect(models);
    const client = adapter.client!;
    await client.unsafe(`drop schema if exists qs_b08_tenant_a cascade; create schema qs_b08_tenant_a`);
    try {
      for (const statement of await postgresDdl([post], { defaultSchema: TENANT })) await client.unsafe(statement);
      const log = recordStatements(client);
      const record = await adapter.withSchema(TENANT).insert(post, contractRecord({ title: "qualified" }));
      expect(log.statements.some((text) => text.includes('"qs_b08_tenant_a"."posts"'))).toBe(true);
      const [row] = (await client.unsafe(`select title from qs_b08_tenant_a.posts where id = $1`, [record.id])) as { title: string }[];
      expect(row?.title).toBe("qualified");
    } finally {
      await client.unsafe(`drop schema if exists qs_b08_tenant_a cascade`);
      await adapter.disconnect();
    }
  });
});

const mongoUrl = process.env.TEST_MONGODB_URL;
describe.skipIf(!mongoUrl)("mongodb views", () => {
  test("a view stores its default-schema collections in the database named after its schema", async () => {
    const adapter = mongodbAdapter({ url: mongoUrl!, database: `qs_b08_root_${Date.now()}` });
    await adapter.connect(models);
    try {
      const record = await adapter.withSchema(TENANT).insert(post, contractRecord({ title: "in tenant db" }));
      const stored = await adapter.client!.db("qs_b08_tenant_a").collection("posts").findOne({ _id: record.id as never });
      expect(stored?.title).toBe("in tenant db");
      expect(await adapter.findById(post, record.id)).toBeNull();
    } finally {
      await adapter.client!.db("qs_b08_tenant_a").dropDatabase();
      await adapter.db!.dropDatabase();
      await adapter.disconnect();
    }
  });
});
