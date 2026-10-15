import { describe, expect, test } from "bun:test";
import { contractItem, contractModels, contractRecord, runAdapterContract } from "../testing/adapter-contract.ts";
import { duplicateKeyField, escapeRegex, mongodbAdapter, toFilter, toSort, type MongodbAdapter } from "./mongodb.ts";

const url = process.env.TEST_MONGODB_URL;

function freshAdapter(): MongodbAdapter {
  const adapter = mongodbAdapter({ url: url!, database: `ss_test_${Bun.randomUUIDv7().replaceAll("-", "")}` });
  const connect = adapter.connect.bind(adapter);
  const disconnect = adapter.disconnect.bind(adapter);
  adapter.connect = async (models) => {
    await connect(models);
    for (const model of models) await adapter.createIndexes(model);
  };
  adapter.disconnect = async () => {
    await adapter.db?.dropDatabase();
    await disconnect();
  };
  return adapter;
}

if (url) {
  runAdapterContract("mongodb", () => freshAdapter());

  describe("mongodb specifics", () => {
    test("ids are stored as string _id and returned as id", async () => {
      const adapter = freshAdapter();
      await adapter.connect(contractModels);
      const record = contractRecord({ title: "a" });
      await adapter.insert(contractItem, record);
      const raw = await adapter.db!.collection("items").findOne({ _id: record.id as never });
      expect(raw?._id as unknown).toBe(record.id);
      expect(raw).not.toHaveProperty("id");
      expect((await adapter.findById(contractItem, record.id))?.id).toBe(record.id);
      await adapter.disconnect();
    });

    test("createIndexes and dropIndexes manage the entity indexes", async () => {
      const adapter = freshAdapter();
      await adapter.connect(contractModels);
      const names = async () => (await adapter.db!.collection("items").indexes()).map((index) => index.name).sort();
      expect(await names()).toEqual(["_id_", "items_code_uq", "items_created_at_idx"]);
      await adapter.dropIndexes(contractItem);
      expect(await names()).toEqual(["_id_"]);
      await adapter.disconnect();
    });

    test("duplicate keys name the field and nulls never collide", async () => {
      const adapter = freshAdapter();
      await adapter.connect(contractModels);
      await adapter.insert(contractItem, contractRecord({ title: "a", code: null }));
      await adapter.insert(contractItem, contractRecord({ title: "b", code: null }));
      await adapter.insert(contractItem, contractRecord({ title: "c", code: "x" }));
      await expect(adapter.insert(contractItem, contractRecord({ title: "d", code: "x" }))).rejects.toMatchObject({ field: "code" });
      await adapter.disconnect();
    });

    test("transactions roll back on throw", async () => {
      const adapter = freshAdapter();
      await adapter.connect(contractModels);
      await expect(
        adapter.transaction(async () => {
          await adapter.insert(contractItem, contractRecord({ title: "a" }));
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await adapter.count(contractItem, [])).toBe(0);
      await adapter.disconnect();
    });
  });
} else {
  test.skip("MongoDB adapter contract (set TEST_MONGODB_URL to run)", () => {});
}

describe("query translation", () => {
  test.each([
    ["eq", { field: "a", op: "eq", value: 1 }, { a: { $eq: 1 } }],
    ["ne", { field: "a", op: "ne", value: 1 }, { $and: [{ a: { $ne: 1 } }, { a: { $ne: null } }] }],
    ["in", { field: "a", op: "in", value: [1, 2] }, { a: { $in: [1, 2] } }],
    ["nin", { field: "a", op: "nin", value: [1] }, { $and: [{ a: { $nin: [1] } }, { a: { $ne: null } }] }],
    ["gt", { field: "a", op: "gt", value: 1 }, { a: { $gt: 1 } }],
    ["gte", { field: "a", op: "gte", value: 1 }, { a: { $gte: 1 } }],
    ["lt", { field: "a", op: "lt", value: 1 }, { a: { $lt: 1 } }],
    ["lte", { field: "a", op: "lte", value: 1 }, { a: { $lte: 1 } }],
    ["contains", { field: "a", op: "contains", value: "a.b" }, { a: { $regex: "a\\.b", $options: "i" } }],
    ["startsWith", { field: "a", op: "startsWith", value: "x" }, { a: { $regex: "^x", $options: "i" } }],
    ["exists true", { field: "a", op: "exists", value: true }, { a: { $ne: null } }],
    ["exists false", { field: "a", op: "exists", value: false }, { a: { $eq: null } }],
    ["isNull true", { field: "a", op: "isNull", value: true }, { a: { $eq: null } }],
    ["isNull false", { field: "a", op: "isNull", value: false }, { a: { $ne: null } }],
    ["id", { field: "id", op: "eq", value: "x" }, { _id: { $eq: "x" } }],
  ] as const)("%s", (_, condition, expected) => {
    expect(toFilter([condition as never])).toEqual({ $and: [expected as never] });
  });

  test("no conditions match everything", () => {
    expect(toFilter([])).toEqual({});
  });

  test("sort maps directions and id", () => {
    expect(toSort([{ field: "title", direction: "asc" }, { field: "id", direction: "desc" }])).toEqual({ title: 1, _id: -1 });
  });
});

test("regex metacharacters are escaped", () => {
  expect(escapeRegex("a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o/p")).toBe("a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o\\/p");
  expect(new RegExp(escapeRegex("a.b"), "i").test("axb")).toBe(false);
});

test("duplicate key errors map to the field", () => {
  expect(duplicateKeyField({ code: 11000, keyPattern: { email: 1 } })).toBe("email");
  expect(duplicateKeyField({ code: 11000, message: "E11000 duplicate key error collection: x index: users_email_uq dup key" })).toBe("email");
  expect(duplicateKeyField({ code: 1 })).toBeUndefined();
});
