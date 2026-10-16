import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import type { Condition, SizeFilter, SortField } from "../query.ts";
import { entity, field } from "./entities.ts";

export const contractOrganization = entity("Organization", [field({ name: "name", type: "string", unique: true })]);

export const contractItem = entity("Item", [
  field({ name: "title", type: "string" }),
  field({ name: "code", type: "string", unique: true, optional: true }),
  field({ name: "score", type: "number", optional: true }),
  field({ name: "active", type: "boolean", optional: true }),
  field({ name: "publishedAt", type: "date", optional: true }),
  field({ name: "status", type: "enum", values: ["draft", "published"], optional: true }),
  field({ name: "organization", type: "ref", target: "Organization", onDelete: "restrict", optional: true }),
  field({ name: "partners", type: "refArray", target: "Organization", onDelete: "pull", optional: true }),
  field({ name: "tags", type: "array", items: { type: "string" }, optional: true }),
  field({
    name: "meta",
    type: "object",
    optional: true,
    fields: [
      { name: "views", type: "number", optional: false },
      { name: "lines", type: "array", optional: true, items: { type: "object", fields: [{ name: "qty", type: "number", optional: false }] } },
    ],
  }),
]);

export const contractModels: EntityModel[] = [contractOrganization, contractItem];

export type AdapterFactory = (models: EntityModel[]) => DatabaseAdapter | Promise<DatabaseAdapter>;

let sequence = 0;
const newId = () => Bun.randomUUIDv7();

export function contractRecord(values: Record<string, unknown>): StoredRecord {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++));
  return { id: newId(), createdAt: at, updatedAt: at, ...values };
}

const page = (where: Condition[] = [], sort: SortField[] = [{ field: "title", direction: "asc" }], limit = 100, offset = 0) => ({
  where,
  sort,
  limit,
  offset,
});

/**
 * Registers the shared behavior every `DatabaseAdapter` must have. Call it from an adapter's test file;
 * the factory receives the models used by the suite and returns a fresh, empty adapter.
 */
export function runAdapterContract(name: string, factory: AdapterFactory): void {
  describe(`${name} adapter contract`, () => {
    let adapter: DatabaseAdapter;

    beforeEach(async () => {
      adapter = await factory(contractModels);
      await adapter.connect(contractModels);
    });

    afterEach(async () => {
      await adapter.disconnect();
    });

    const insertItems = async (...items: Record<string, unknown>[]) => {
      const stored: StoredRecord[] = [];
      for (const item of items) stored.push(await adapter.insert(contractItem, contractRecord(item)));
      return stored;
    };
    const titles = async (where: Condition[], sort?: SortField[]) =>
      (await adapter.findMany(contractItem, page(where, sort))).data.map((record) => record.title);

    test("round-trips every field kind", async () => {
      const organization = await adapter.insert(contractOrganization, contractRecord({ name: "Acme" }));
      const values = {
        title: "Full",
        code: "A-1",
        score: 4.5,
        active: true,
        publishedAt: new Date("2026-02-03T04:05:06.789Z"),
        status: "published",
        organization: organization.id,
        partners: [organization.id],
        tags: ["a", "b"],
        meta: { views: 3, lines: [{ qty: 1 }, { qty: 2 }] },
      };
      const [inserted] = await insertItems(values);
      const found = await adapter.findById(contractItem, inserted!.id);
      expect(found).toEqual({ ...values, id: inserted!.id, createdAt: inserted!.createdAt, updatedAt: inserted!.updatedAt });
      expect(found!.publishedAt).toBeInstanceOf(Date);
      expect(found!.createdAt).toBeInstanceOf(Date);
      expect(found!.updatedAt).toBeInstanceOf(Date);
    });

    test("returns null for absent optional fields", async () => {
      const [inserted] = await insertItems({ title: "Minimal" });
      const found = await adapter.findById(contractItem, inserted!.id);
      for (const name of ["code", "score", "active", "publishedAt", "status", "organization", "tags", "meta"]) {
        expect(found![name]).toBeNull();
      }
      expect(found!.partners).toEqual([]);
    });

    test("findById and findOne return null when nothing matches", async () => {
      expect(await adapter.findById(contractItem, newId())).toBeNull();
      expect(await adapter.findOne(contractItem, [{ field: "title", op: "eq", value: "nope" }])).toBeNull();
    });

    test("findOne returns a matching record", async () => {
      await insertItems({ title: "One", score: 1 }, { title: "Two", score: 2 });
      const found = await adapter.findOne(contractItem, [{ field: "score", op: "eq", value: 2 }]);
      expect(found!.title).toBe("Two");
    });

    describe("filter operators", () => {
      beforeEach(async () => {
        await insertItems(
          { title: "A", score: 1, active: true, status: "draft", publishedAt: new Date("2026-01-01T00:00:00Z") },
          { title: "B", score: 2, active: false, status: "published", publishedAt: new Date("2026-02-01T00:00:00Z") },
          { title: "C", score: 3, active: true },
        );
      });

      test.each<[string, Condition[], string[]]>([
        ["eq", [{ field: "score", op: "eq", value: 2 }], ["B"]],
        ["ne", [{ field: "score", op: "ne", value: 2 }], ["A", "C"]],
        ["in", [{ field: "status", op: "in", value: ["draft", "published"] }], ["A", "B"]],
        ["nin", [{ field: "score", op: "nin", value: [1, 3] }], ["B"]],
        ["gt", [{ field: "score", op: "gt", value: 1 }], ["B", "C"]],
        ["gte", [{ field: "score", op: "gte", value: 2 }], ["B", "C"]],
        ["lt", [{ field: "publishedAt", op: "lt", value: new Date("2026-01-15T00:00:00Z") }], ["A"]],
        ["lte", [{ field: "score", op: "lte", value: 2 }], ["A", "B"]],
        ["exists true", [{ field: "status", op: "exists", value: true }], ["A", "B"]],
        ["exists false", [{ field: "status", op: "exists", value: false }], ["C"]],
        ["isNull true", [{ field: "publishedAt", op: "isNull", value: true }], ["C"]],
        ["isNull false", [{ field: "publishedAt", op: "isNull", value: false }], ["A", "B"]],
        ["boolean eq", [{ field: "active", op: "eq", value: true }], ["A", "C"]],
        ["combined with AND", [{ field: "active", op: "eq", value: true }, { field: "score", op: "gt", value: 1 }], ["C"]],
        ["ne excludes nulls", [{ field: "status", op: "ne", value: "draft" }], ["B"]],
      ])("%s", async (_, where, expected) => {
        expect(await titles(where)).toEqual(expected);
      });

      test("id and system timestamps are filterable", async () => {
        const [first] = (await adapter.findMany(contractItem, page())).data;
        expect(await titles([{ field: "id", op: "eq", value: first!.id }])).toEqual(["A"]);
        expect(await titles([{ field: "createdAt", op: "gte", value: first!.createdAt }])).toEqual(["A", "B", "C"]);
      });
    });

    describe("case-insensitive literal text matching", () => {
      beforeEach(async () => {
        await insertItems(
          { title: "Discount 50% off" },
          { title: "500 units" },
          { title: "snake_case" },
          { title: "snakeycase" },
          { title: "a.b (x)" },
          { title: "axb x" },
        );
      });
      const text = (op: "contains" | "startsWith", value: string): Condition[] => [
        { field: "title", op, value, caseInsensitive: true, literal: true },
      ];

      test("contains 50% matches only the literal value", async () => {
        expect(await titles(text("contains", "50%"))).toEqual(["Discount 50% off"]);
      });
      test("underscore is literal", async () => {
        expect(await titles(text("contains", "_c"))).toEqual(["snake_case"]);
      });
      test("regex characters are literal", async () => {
        expect(await titles(text("contains", "a.b (x"))).toEqual(["a.b (x)"]);
      });
      test("matching ignores case", async () => {
        expect(await titles(text("contains", "DISCOUNT"))).toEqual(["Discount 50% off"]);
        expect(await titles(text("startsWith", "SNAKE"))).toEqual(["snake_case", "snakeycase"]);
      });
      test("startsWith anchors at the beginning", async () => {
        expect(await titles(text("startsWith", "units"))).toEqual([]);
        expect(await titles(text("startsWith", "500"))).toEqual(["500 units"]);
      });
    });

    test("sorts by several fields", async () => {
      await insertItems({ title: "B", score: 1 }, { title: "A", score: 2 }, { title: "C", score: 1 });
      expect(
        await titles([], [
          { field: "score", direction: "asc" },
          { field: "title", direction: "desc" },
        ]),
      ).toEqual(["C", "B", "A"]);
    });

    test("paginates with limit, offset and total", async () => {
      await insertItems({ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }, { title: "E" });
      const result = await adapter.findMany(contractItem, page([], undefined, 2, 1));
      expect(result.data.map((record) => record.title)).toEqual(["B", "C"]);
      expect(result.total).toBe(5);
      const filtered = await adapter.findMany(contractItem, page([{ field: "title", op: "in", value: ["A", "E"] }], undefined, 1, 0));
      expect(filtered.total).toBe(2);
      expect(filtered.data).toHaveLength(1);
    });

    test("unique violations on insert name the field", async () => {
      await insertItems({ title: "A", code: "dup" });
      const attempt = insertItems({ title: "B", code: "dup" });
      await expect(attempt).rejects.toBeInstanceOf(UniqueViolationError);
      await expect(attempt).rejects.toMatchObject({ field: "code" });
    });

    test("unique violations on update name the field", async () => {
      const [, second] = await insertItems({ title: "A", code: "one" }, { title: "B", code: "two" });
      const attempt = adapter.updateById(contractItem, second!.id, { code: "one" });
      await expect(attempt).rejects.toBeInstanceOf(UniqueViolationError);
      await expect(attempt).rejects.toMatchObject({ field: "code" });
    });

    test("updates fields, clears them with null and reports misses", async () => {
      const [item] = await insertItems({ title: "A", score: 1, tags: ["x"] });
      expect(await adapter.updateById(contractItem, item!.id, { title: "A2", score: null, tags: ["y", "z"] })).toBe(true);
      expect(await adapter.findById(contractItem, item!.id)).toMatchObject({ title: "A2", score: null, tags: ["y", "z"] });
      expect(await adapter.updateById(contractItem, newId(), { title: "x" })).toBe(false);
    });

    test("deletes records and reports misses", async () => {
      const [item] = await insertItems({ title: "A" });
      expect(await adapter.deleteById(contractItem, item!.id)).toBe(true);
      expect(await adapter.findById(contractItem, item!.id)).toBeNull();
      expect(await adapter.deleteById(contractItem, item!.id)).toBe(false);
    });

    test("counts records matching conditions", async () => {
      await insertItems({ title: "A", score: 1 }, { title: "B", score: 2 }, { title: "C", score: 3 });
      expect(await adapter.count(contractItem, [])).toBe(3);
      expect(await adapter.count(contractItem, [{ field: "score", op: "gte", value: 2 }])).toBe(2);
    });

    describe("reference arrays", () => {
      const organizations = async (...names: string[]) => {
        const ids: string[] = [];
        for (const name of names) ids.push((await adapter.insert(contractOrganization, contractRecord({ name }))).id);
        return ids;
      };

      test("keep their order on insert and find", async () => {
        const [a, b, c] = await organizations("a", "b", "c");
        const [item] = await insertItems({ title: "A", partners: [c, a, b] });
        expect((await adapter.findById(contractItem, item!.id))!.partners).toEqual([c, a, b]);
        expect((await adapter.findOne(contractItem, [{ field: "title", op: "eq", value: "A" }]))!.partners).toEqual([c, a, b]);
      });

      test("are loaded for every record of a page", async () => {
        const [a, b] = await organizations("a", "b");
        await insertItems({ title: "A", partners: [a] }, { title: "B", partners: [b, a] }, { title: "C" });
        const { data } = await adapter.findMany(contractItem, page());
        expect(data.map((record) => record.partners)).toEqual([[a], [b, a], []]);
      });

      describe("filters", () => {
        const setupFilters = async () => {
          const [a, b, c] = await organizations("a", "b", "c");
          await insertItems(
            { title: "none" },
            { title: "one", partners: [a] },
            { title: "two", partners: [a, b] },
            { title: "three", partners: [c, b, a] },
          );
          return { a: a!, b: b!, c: c! };
        };
        const titlesWhere = async (where: Condition[]) => (await titles(where)).sort();

        test("contains", async () => {
          const { b } = await setupFilters();
          expect(await titlesWhere([{ field: "partners", op: "contains", value: b }])).toEqual(["three", "two"]);
        });
        test("containsAny and containsAll", async () => {
          const { a, b, c } = await setupFilters();
          expect(await titlesWhere([{ field: "partners", op: "containsAny", value: [b, c] }])).toEqual(["three", "two"]);
          expect(await titlesWhere([{ field: "partners", op: "containsAll", value: [a, b] }])).toEqual(["three", "two"]);
          expect(await titlesWhere([{ field: "partners", op: "containsAll", value: [a, c] }])).toEqual(["three"]);
        });
        test("size comparisons, including zero", async () => {
          await setupFilters();
          const size = (compare: SizeFilter["compare"], count: number): Condition[] => [
            { field: "partners", op: "size", value: { compare, count } },
          ];
          expect(await titlesWhere(size("eq", 0))).toEqual(["none"]);
          expect(await titlesWhere(size("gte", 2))).toEqual(["three", "two"]);
          expect(await titlesWhere(size("lt", 2))).toEqual(["none", "one"]);
          expect(await titlesWhere(size("ne", 1))).toEqual(["none", "three", "two"]);
          expect(await titlesWhere(size("gt", 2))).toEqual(["three"]);
          expect(await titlesWhere(size("lte", 1))).toEqual(["none", "one"]);
        });
        test("isEmpty", async () => {
          await setupFilters();
          expect(await titlesWhere([{ field: "partners", op: "isEmpty", value: true }])).toEqual(["none"]);
          expect(await titlesWhere([{ field: "partners", op: "isEmpty", value: false }])).toEqual(["one", "three", "two"]);
        });
        test("count and total use the same filters", async () => {
          const { b } = await setupFilters();
          const where: Condition[] = [{ field: "partners", op: "contains", value: b }];
          expect(await adapter.count(contractItem, where)).toBe(2);
          expect((await adapter.findMany(contractItem, page(where, undefined, 1, 0))).total).toBe(2);
        });
      });

      test("are replaced on update, and other fields stay", async () => {
        const [a, b] = await organizations("a", "b");
        const [item] = await insertItems({ title: "A", partners: [a] });
        expect(await adapter.updateById(contractItem, item!.id, { partners: [b, a] })).toBe(true);
        expect(await adapter.findById(contractItem, item!.id)).toMatchObject({ title: "A", partners: [b, a] });
        await adapter.updateById(contractItem, item!.id, { title: "A2", partners: [] });
        expect(await adapter.findById(contractItem, item!.id)).toMatchObject({ title: "A2", partners: [] });
        expect(await adapter.updateById(contractItem, newId(), { partners: [a] })).toBe(false);
      });
    });

    test("transaction runs the function and returns its value", async () => {
      const value = await adapter.transaction(async () => {
        await insertItems({ title: "A" });
        return 42;
      });
      expect(value).toBe(42);
      expect(await adapter.count(contractItem, [])).toBe(1);
    });
  });
}
