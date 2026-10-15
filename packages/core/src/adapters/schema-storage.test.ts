import { describe, expect, test } from "bun:test";
import { MongoClient } from "mongodb";
import { HttpError } from "../errors.ts";
import { createRepositories, type Repository } from "../repository.ts";
import { entity, field } from "../testing/entities.ts";
import { memoryAdapter } from "./memory.ts";
import { mongodbAdapter, mongoIndexSpecs } from "./mongodb.ts";

const suffix = () => Bun.randomUUIDv7().replaceAll("-", "").slice(-12);

function models(schema: string) {
  const authUser = entity("User", [field({ name: "email", type: "string", unique: true })], {
    key: `${schema}/User`,
    schema,
    schemaKey: schema,
  });
  const user = entity("User", [
    field({ name: "email", type: "string", unique: true }),
    field({ name: "account", type: "ref", target: `${schema}/User`, onDelete: "restrict", optional: true }),
  ]);
  return { authUser, user };
}

test("the in-memory adapter keeps one namespace per schema", async () => {
  const { authUser, user } = models("auth");
  const adapter = memoryAdapter();
  await adapter.connect([authUser, user]);
  const repos = createRepositories([authUser, user], adapter);
  await (repos.users as Repository).create({ email: "a@b.co" });
  await ((repos.auth as Record<string, Repository>).users as Repository).create({ email: "a@b.co" });
  expect(await adapter.count(user, [])).toBe(1);
  expect(await adapter.count(authUser, [])).toBe(1);
});

test("index specs carry the entity schema", () => {
  const { authUser, user } = models("auth");
  expect(mongoIndexSpecs(authUser).every((spec) => spec.schema === "auth")).toBe(true);
  expect(mongoIndexSpecs(user).every((spec) => spec.schema === null)).toBe(true);
});

const url = process.env.TEST_MONGODB_URL;
if (url) {
  describe("MongoDB databases per schema", () => {
    test("explicit, default and configured databases; cross-database references", async () => {
      const schema = `auth${suffix()}`;
      const tenant = `tenant-${suffix()}`;
      const configured = `configured_${suffix()}`;
      const { authUser, user } = models(schema);
      const client = new MongoClient(url);
      await client.connect();
      try {
        const adapter = mongodbAdapter({ url, database: configured });
        await adapter.connect([authUser, user], { defaultSchema: tenant });
        await adapter.createIndexes(authUser);
        await adapter.createIndexes(user);
        const repos = createRepositories([authUser, user], adapter);
        const account = await ((repos[schema] as Record<string, Repository>).users as Repository).create({ email: "a@b.co" });
        await (repos.users as Repository).create({ email: "a@b.co", account: account.id });

        expect(await client.db(schema).collection("users").countDocuments()).toBe(1);
        expect(await client.db(tenant.replaceAll("-", "_")).collection("users").countDocuments()).toBe(1);
        expect(await client.db(configured).collection("users").countDocuments()).toBe(0);
        expect((await client.db(schema).collection("users").indexes()).map((index) => index.name)).toContain("users_email_uq");
        expect((await client.db(tenant.replaceAll("-", "_")).collection("users").indexes()).map((index) => index.name)).toContain("users_email_uq");

        const error = await ((repos[schema] as Record<string, Repository>).users as Repository).delete(account.id).catch((caught) => caught);
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).status).toBe(409);
        await expect((repos.users as Repository).create({ email: "c@d.co", account: Bun.randomUUIDv7() })).rejects.toBeInstanceOf(HttpError);
        await adapter.disconnect();

        const fallback = mongodbAdapter({ url, database: configured });
        await fallback.connect([user]);
        await createRepositories([user], fallback).users!;
        expect(fallback.db?.databaseName).toBe(configured);
        await fallback.disconnect();
      } finally {
        for (const name of [schema, tenant.replaceAll("-", "_"), configured]) await client.db(name).dropDatabase();
        await client.close();
      }
    });
  });
} else {
  test.skip("MongoDB databases per schema (set TEST_MONGODB_URL to run)", () => {});
}
