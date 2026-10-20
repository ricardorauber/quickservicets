import { expect, test } from "bun:test";
import { UniqueViolationError, type DatabaseAdapter } from "./adapter.ts";

test("a complete stub satisfies the interface and an incomplete one does not", () => {
  const stub: DatabaseAdapter = {
    connect: async () => {},
    disconnect: async () => {},
    insert: async (_, record) => record,
    findById: async () => null,
    findOne: async () => null,
    findMany: async () => ({ data: [], total: 0 }),
    updateById: async () => null,
    deleteById: async () => false,
    count: async () => 0,
    aggregate: async () => ({}),
    transaction: (fn) => fn(),
  };
  // @ts-expect-error count is missing
  const incomplete: DatabaseAdapter = { ...stub, count: undefined };
  expect(stub).toBeDefined();
  expect(incomplete).toBeDefined();
});

test("UniqueViolationError exposes the field and is an Error", () => {
  const error = new UniqueViolationError("email");
  expect(error).toBeInstanceOf(Error);
  expect(error.field).toBe("email");
});
