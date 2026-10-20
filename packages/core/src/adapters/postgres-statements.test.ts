import { describe, expect, test } from "bun:test";
import { buildDrizzleSchema } from "../sql/schema.ts";
import { entity, field } from "../testing/entities.ts";
import { arrayLiteral } from "./postgres-conditions.ts";
import { EntityStatements } from "./postgres-statements.ts";

const organization = entity("Organization", [field({ name: "name", type: "string" })]);
const user = entity("User", [
  field({ name: "email", type: "string" }),
  field({ name: "passwordHash", type: "string", optional: true }),
  field({ name: "tags", type: "array", items: { type: "string" }, optional: true }),
  field({ name: "bornAt", type: "date", optional: true }),
  field({ name: "teams", type: "refArray", target: "Organization", onDelete: "pull", optional: true }),
]);
const invoice = entity("Invoice", [field({ name: "total", type: "number" }), field({ name: "lines", type: "refArray", target: "Organization", onDelete: "pull", optional: true })], {
  key: "billing/Invoice",
  schema: "billing",
});
const teams = `coalesce((select array_agg("users__teams"."target_id" order by "users__teams"."position") from "users__teams" where "users__teams"."owner_id" = "users"."id"), '{}') as "teams"`;
const columns = '"id", "created_at" as "createdAt", "updated_at" as "updatedAt", "email", "password_hash" as "passwordHash", "tags", "born_at" as "bornAt"';
const statementsOf = (model = user) => new EntityStatements(model, buildDrizzleSchema([organization, user, invoice], "postgres"));

describe("text per shape", () => {
  test("a read selects every column under its field name", () => {
    expect(statementsOf().findById("a")).toEqual({
      text: `select ${columns}, ${teams} from "users" where "id" = $1 limit 1`,
      params: ["a"],
    });
  });

  test("the same shape reuses the same text, whatever the values", () => {
    const statements = statementsOf();
    const first = statements.insert({ id: "a", email: "a@x.co", tags: ["x"] });
    const second = statements.insert({ tags: [], email: "b@x.co", id: "b" });
    expect(second.text).toBe(first.text);
    expect(first.text).toBe('insert into "users" ("email", "id", "tags") values ($1, $2, $3) returning "id", "created_at" as "createdAt", "updated_at" as "updatedAt", "email", "password_hash" as "passwordHash", "tags", "born_at" as "bornAt"');
    expect(second.params).toEqual(["b@x.co", "b", "[]"]);
    expect(statements.insert({ id: "c", email: "c@x.co", bornAt: undefined }).text).toBe(statements.insert({ id: "d", email: "d@x.co" }).text);
    expect(statements.insert({ id: "c", email: "c@x.co", passwordHash: "h" }).text).not.toBe(first.text);
  });

  test("updates are keyed by written columns and plain conditions", () => {
    const statements = statementsOf();
    const at = new Date("2026-01-01T00:00:00Z");
    const update = statements.updateById("a", { updatedAt: at, email: "x@x.co" }, [{ field: "updatedAt", op: "lt", value: at }]);
    expect(update.text).toBe(`update "users" set "email" = $1, "updated_at" = $2 where "users"."id" = $3 and ("users"."updated_at" < $4) returning "id", "created_at" as "createdAt", "updated_at" as "updatedAt", "email", "password_hash" as "passwordHash", "tags", "born_at" as "bornAt", ${teams}`);
    expect(update.params).toEqual(["x@x.co", at.toISOString(), "a", at.toISOString()]);
    expect(statements.updateById("b", { email: "y@x.co", updatedAt: new Date() }, [{ field: "updatedAt", op: "lt", value: new Date() }])!.text).toBe(update.text);
    expect(statements.updateById("a", {}, [])!.text).toStartWith('select "id"');
  });

  test("reads aggregate each junction-stored reference array in position order; inserts return the columns only", () => {
    const statements = statementsOf();
    expect(statements.findById("a").text).toEndWith(`"born_at" as "bornAt", ${teams} from "users" where "id" = $1 limit 1`);
    expect(statements.findMany([], [], 10, 0).text).toContain(teams);
    expect(statements.updateById("a", { email: "x" }, []).text).toEndWith(`returning ${columns}, ${teams}`);
    expect(statements.insert({ id: "a", email: "x" }).text).toEndWith(`returning ${columns}`);
  });
});

describe("schemas", () => {
  test("an explicit schema qualifies the table and its junctions", () => {
    const statements = statementsOf(invoice);
    expect(statements.findById("a").text).toContain('from "billing"."invoices" where');
    expect(statements.deleteById("a").text).toBe('delete from "billing"."invoices" where "id" = $1 returning "id"');
    expect(statements.junctions).toEqual([{ field: "lines", name: '"billing"."invoices__lines"' }]);
  });

  test("default-schema tables stay unqualified, so the connection's search path applies", () => {
    expect(statementsOf().deleteById("a").text).toBe('delete from "users" where "id" = $1 returning "id"');
  });
});
