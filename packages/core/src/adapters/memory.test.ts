import { describe, expect, test } from "bun:test";
import { UniqueViolationError } from "../adapter.ts";
import { contractItem, contractModels, contractRecord, runAdapterContract } from "../testing/adapter-contract.ts";
import { memoryAdapter } from "./memory.ts";

runAdapterContract("memory", () => memoryAdapter());

const connected = async () => {
  const adapter = memoryAdapter();
  await adapter.connect(contractModels);
  return adapter;
};

describe("deep-copy isolation", () => {
  test("mutating the inserted object does not change stored data", async () => {
    const adapter = await connected();
    const record = contractRecord({ title: "A", tags: ["x"] });
    await adapter.insert(contractItem, record);
    (record.tags as string[]).push("y");
    record.title = "changed";
    expect(await adapter.findById(contractItem, record.id)).toMatchObject({ title: "A", tags: ["x"] });
  });

  test("mutating a read result does not change stored data", async () => {
    const adapter = await connected();
    const { id } = await adapter.insert(contractItem, contractRecord({ title: "A", meta: { views: 1 } }));
    const found = (await adapter.findById(contractItem, id))!;
    found.title = "changed";
    (found.meta as { views: number }).views = 99;
    expect(await adapter.findById(contractItem, id)).toMatchObject({ title: "A", meta: { views: 1 } });
  });
});

test("unique enforcement on update ignores the record's own value", async () => {
  const adapter = await connected();
  const { id } = await adapter.insert(contractItem, contractRecord({ title: "A", code: "one" }));
  await adapter.insert(contractItem, contractRecord({ title: "B", code: "two" }));
  expect(await adapter.updateById(contractItem, id, { code: "one", title: "A2" })).toMatchObject({ id, code: "one", title: "A2" });
  await expect(adapter.updateById(contractItem, id, { code: "two" })).rejects.toBeInstanceOf(UniqueViolationError);
});

test("null values do not trigger unique violations", async () => {
  const adapter = await connected();
  await adapter.insert(contractItem, contractRecord({ title: "A", code: null }));
  await adapter.insert(contractItem, contractRecord({ title: "B", code: null }));
  expect(await adapter.count(contractItem, [])).toBe(2);
});

test("disconnect clears all data", async () => {
  const adapter = await connected();
  await adapter.insert(contractItem, contractRecord({ title: "A" }));
  await adapter.disconnect();
  await adapter.connect(contractModels);
  expect(await adapter.count(contractItem, [])).toBe(0);
});
