import { describe, expect, test } from "bun:test";
import type { Condition } from "../query.ts";
import { buildDrizzleSchema } from "../sql/schema.ts";
import { entity, field } from "../testing/entities.ts";
import { compileConditions, compileSort } from "./postgres-conditions.ts";
import { EntityStatements } from "./postgres-statements.ts";

const organization = entity("Organization", [field({ name: "name", type: "string" })]);
const user = entity("User", [
  field({ name: "email", type: "string" }),
  field({ name: "age", type: "number", optional: true }),
  field({ name: "active", type: "boolean", optional: true }),
  field({ name: "bornAt", type: "date", optional: true }),
  field({ name: "teams", type: "refArray", target: "Organization", onDelete: "pull", optional: true }),
]);
const statements = () => new EntityStatements(user, buildDrizzleSchema([organization, user], "postgres"));
const where = (...conditions: Condition[]) => compileConditions(conditions, statements());
const date = new Date("2026-01-02T03:04:05.000Z");
const owned = '"users__teams"."owner_id" = "users"."id"';

describe("operators and groups", () => {
  test.each<[string, Condition, string, unknown[]]>([
    ["eq", { field: "email", op: "eq", value: "a" }, '"users"."email" = $1', ["a"]],
    ["ne", { field: "age", op: "ne", value: 3 }, '"users"."age" <> $1', [3]],
    ["gt", { field: "bornAt", op: "gt", value: date }, '"users"."born_at" > $1', [date.toISOString()]],
    ["gte", { field: "age", op: "gte", value: 1 }, '"users"."age" >= $1', [1]],
    ["lt", { field: "createdAt", op: "lt", value: date }, '"users"."created_at" < $1', [date.toISOString()]],
    ["lte", { field: "age", op: "lte", value: 2 }, '"users"."age" <= $1', [2]],
    ["in", { field: "email", op: "in", value: ["a", "b"] }, '"users"."email" = any($1::text[])', ['{"a","b"}']],
    ["nin numbers", { field: "age", op: "nin", value: [1, 2.5] }, '"users"."age" <> all($1::float8[])', ['{"1","2.5"}']],
    ["in dates", { field: "bornAt", op: "in", value: [date] }, '"users"."born_at" = any($1::timestamptz[])', ['{"2026-01-02T03:04:05.000Z"}']],
    ["boolean eq", { field: "active", op: "eq", value: true }, '"users"."active" = $1', [true]],
    ["contains", { field: "email", op: "contains", value: "x", caseInsensitive: true, literal: true }, `"users"."email" ilike $1 escape '\\'`, ["%x%"]],
    ["startsWith", { field: "email", op: "startsWith", value: "x" }, `"users"."email" ilike $1 escape '\\'`, ["x%"]],
    ["exists", { field: "age", op: "exists", value: true }, '"users"."age" is not null', []],
    ["exists false", { field: "age", op: "exists", value: false }, '"users"."age" is null', []],
    ["isNull", { field: "age", op: "isNull", value: true }, '"users"."age" is null', []],
    ["isNull false", { field: "age", op: "isNull", value: false }, '"users"."age" is not null', []],
    ["array contains", { field: "teams", op: "contains", value: "t" }, `exists (select 1 from "users__teams" where ${owned} and "users__teams"."target_id" = $1)`, ["t"]],
    ["containsAny", { field: "teams", op: "containsAny", value: ["t", "u"] }, `exists (select 1 from "users__teams" where ${owned} and "users__teams"."target_id" = any($1::text[]))`, ['{"t","u"}']],
    ["containsAll", { field: "teams", op: "containsAll", value: ["t", "u"] }, `(select count(*) from "users__teams" where ${owned} and "users__teams"."target_id" = any($1::text[])) = $2`, ['{"t","u"}', 2]],
    ["size", { field: "teams", op: "size", value: { compare: "gte", count: 2 } }, `(select count(*) from "users__teams" where ${owned}) >= $1`, [2]],
    ["isEmpty", { field: "teams", op: "isEmpty", value: true }, `not exists (select 1 from "users__teams" where ${owned})`, []],
    ["isEmpty false", { field: "teams", op: "isEmpty", value: false }, `exists (select 1 from "users__teams" where ${owned})`, []],
  ])("%s", (_, condition, text, params) => {
    expect(where(condition)).toMatchObject({ text: `(${text})`, params });
  });

  test("lists combine with AND, groups nest, and empty groups match everything or nothing", () => {
    const compiled = where(
      { field: "active", op: "eq", value: true },
      { group: "or", conditions: [{ field: "age", op: "lt", value: 18 }, { group: "and", conditions: [{ field: "age", op: "gt", value: 65 }, { field: "email", op: "ne", value: "x" }] }] },
      { group: "or", conditions: [] },
      { group: "and", conditions: [] },
    );
    expect(compiled.text).toBe('("users"."active" = $1 and ("users"."age" < $2 or ("users"."age" > $3 and "users"."email" <> $4)) and 1 = 0 and 1 = 1)');
    expect(compiled.params).toEqual([true, 18, 65, "x"]);
    expect(where().text).toBe("");
  });

  test("parameters are numbered from the given position", () => {
    expect(compileConditions([{ field: "email", op: "eq", value: "a" }], statements(), 4).text).toBe('("users"."email" = $4)');
  });

  test("unknown fields and misplaced operators fail as before", () => {
    expect(() => where({ field: "nope", op: "eq", value: 1 })).toThrow('Unknown column for field "nope"');
    expect(() => where({ field: "age", op: "isEmpty", value: true })).toThrow("Operator isEmpty only applies to reference arrays");
    expect(() => where({ field: "teams", op: "eq", value: "x" })).toThrow("Operator eq is not supported on reference arrays");
  });
});

describe("shape cache", () => {
  test("the key leaves out values, so the same shape reuses the same text", () => {
    const shared = statements();
    const filters = (role: string, age: number): Condition[] => [
      { field: "email", op: "contains", value: role, caseInsensitive: true, literal: true },
      { field: "age", op: "gte", value: age },
      { field: "teams", op: "containsAny", value: [role] },
    ];
    const sort = [{ field: "age", direction: "desc" as const }];
    const first = shared.findMany(filters("admin", 30), sort, 20, 0);
    expect(shared.cached(first.key)).toBe(true);
    const second = shared.findMany(filters("member", 41), sort, 10, 40);
    expect(second.key).toBe(first.key);
    expect(second.text).toBe(first.text);
    expect(second.params).toEqual(["%member%", 41, '{"member"}', 10, 40]);
    expect(shared.findMany(filters("x", 1), [{ field: "age", direction: "asc" }], 20, 0).key).not.toBe(first.key);
    expect(shared.findMany([{ field: "age", op: "gt", value: 1 }], sort, 20, 0).key).not.toBe(first.key);
    expect(where({ field: "age", op: "exists", value: true }).key).not.toBe(where({ field: "age", op: "exists", value: false }).key);
  });
});

describe("literal matching", () => {
  test("wildcards and quotes only reach the parameters, escaped", () => {
    const compiled = statements().findMany([{ field: "email", op: "contains", value: "50%_'; drop table users; --", caseInsensitive: true, literal: true }], [], 20, 0);
    expect(compiled.params[0]).toBe("%50\\%\\_'; drop table users; --%");
    expect(compiled.text).not.toContain("50");
    expect(compiled.text).not.toContain("drop");
    expect(compiled.text).toContain(`ilike $1 escape '\\'`);
  });
});

describe("sort and paging", () => {
  test("sort fields in order, then limit and offset as parameters after the filters", () => {
    const compiled = statements().findMany([{ field: "age", op: "gte", value: 30 }], [{ field: "age", direction: "desc" }, { field: "email", direction: "asc" }, { field: "id", direction: "desc" }], 20, 40);
    expect(compiled.text).toBe(
      'select "id", "created_at" as "createdAt", "updated_at" as "updatedAt", "email", "age", "active", "born_at" as "bornAt" from "users" where ("users"."age" >= $1) order by "users"."age" desc, "users"."email" asc, "users"."id" desc limit $2 offset $3',
    );
    expect(compiled.params).toEqual([30, 20, 40]);
    expect(compileSort([], statements()).text).toBe("");
    expect(() => compileSort([{ field: "teams", direction: "asc" }], statements())).toThrow('Unknown column for field "teams"');
  });

  test("counts and aggregates share the translation", () => {
    const shared = statements();
    expect(shared.count([{ field: "age", op: "gt", value: 1 }])).toEqual({ text: 'select count(*) as "total" from "users" where ("users"."age" > $1)', params: [1] });
    const aggregate = shared.aggregate([{ field: "active", op: "eq", value: true }], {
      all: { fn: "count" },
      adults: { fn: "count", where: [{ field: "age", op: "gte", value: 18 }] },
      averageAge: { fn: "avg", field: "age" },
      firstBorn: { fn: "min", field: "bornAt" },
    });
    expect(aggregate.text).toBe(
      'select count(*) as "all", count(*) filter (where ("users"."age" >= $1)) as "adults", avg("users"."age") as "averageAge", min("users"."born_at") as "firstBorn" from "users" where ("users"."active" = $2)',
    );
    expect(aggregate.params).toEqual([18, true]);
    expect(aggregate.decode({ all: "3", adults: 2n, averageAge: 40.5, firstBorn: "2026-01-02T03:04:05.000Z" })).toEqual({ all: 3, adults: 2, averageAge: 40.5, firstBorn: date });
    expect(aggregate.decode({ all: 0, adults: 0, averageAge: null, firstBorn: null })).toEqual({ all: 0, adults: 0, averageAge: null, firstBorn: null });
  });
});
