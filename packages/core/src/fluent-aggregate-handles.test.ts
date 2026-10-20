import { expect, test } from "bun:test";
import { aggregatesOf, conditionsOf, type AggregateFields, type QueryFields } from "./fluent-query.ts";
import { entity, field } from "./testing/entities.ts";

const user = entity("User", [field({ name: "age", type: "number", optional: true }), field({ name: "role", type: "enum", values: ["admin", "member"] })]);
const team = entity("Team", [field({ name: "size", type: "number" })]);

type UserRecord = { id: string; createdAt: Date; updatedAt: Date; age?: number | null; role: "admin" | "member" };
type TeamRecord = { id: string; createdAt: Date; updatedAt: Date; size: number };

test("the aggregate handles of a model are built once and reused by every aggregate", () => {
  const seen: unknown[] = [];
  const lambda = (u: AggregateFields<UserRecord>) => {
    seen.push(u);
    return { members: u.count(), averageAge: u.age.avg() };
  };
  aggregatesOf<UserRecord>(user, lambda);
  aggregatesOf<UserRecord>(user, lambda);
  aggregatesOf<TeamRecord>(team, (t) => {
    seen.push(t);
    return { total: t.size.sum() };
  });
  expect(seen[0]).toBe(seen[1]);
  expect(seen[2]).not.toBe(seen[0]);
  expect(aggregatesOf<UserRecord>(user, lambda)).toEqual({ members: { fn: "count" }, averageAge: { fn: "avg", field: "age" } });
});

test("where handles have no aggregate functions", () => {
  aggregatesOf<UserRecord>(user, (u) => ({ total: u.age.sum(), admins: u.count(u.role.eq("admin")) }));
  let handles: QueryFields<UserRecord> | undefined;
  conditionsOf<UserRecord>(user, (u) => {
    handles = u;
    // @ts-expect-error where handles have no sum
    expect(u.age.sum).toBeUndefined();
    return u.age.gte(18);
  });
  const age = handles!.age as unknown as Record<string, unknown>;
  for (const fn of ["sum", "avg", "min", "max"]) expect(age[fn]).toBeUndefined();
  expect(Object.keys(handles!)).not.toContain("count");
});
