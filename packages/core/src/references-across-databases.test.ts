import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import type { DatabaseAdapter, FindManyOptions } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import type { EntityModel } from "./model.ts";
import { crossDatabaseReferences, crossDatabaseWarning } from "./named-databases.ts";
import { errorOf, startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { entity, field } from "./testing/entities.ts";
import { postgresDdl } from "./testing/postgres.ts";
import { sqliteDdl } from "./testing/sql.ts";

const customer = entity("Customer", [field({ name: "name", type: "string" })], { database: "default" });
const tag = entity("Tag", [field({ name: "label", type: "string" })], { database: "default" });
const order = entity(
  "Order",
  [
    field({ name: "number", type: "string" }),
    field({ name: "customer", type: "ref", target: "Customer", onDelete: "restrict", optional: true }),
    field({ name: "tags", type: "refArray", target: "Tag", onDelete: "pull", optional: true }),
  ],
  { database: "orders" },
);
const line = entity("Line", [field({ name: "order", type: "ref", target: "Order", onDelete: "cascade" })], { database: "orders" });
const models = [customer, tag, order, line];

const running: TestApp[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
});

/** An adapter whose `findMany` calls are recorded by entity. */
function spied(adapter: DatabaseAdapter, calls: string[]): DatabaseAdapter {
  const findMany = adapter.findMany.bind(adapter);
  adapter.findMany = (model: EntityModel, options: FindManyOptions) => {
    calls.push(model.key);
    return findMany(model, options);
  };
  return adapter;
}

async function start(main: DatabaseAdapter = memoryAdapter(), orders: DatabaseAdapter = memoryAdapter()) {
  const app = await startTestApp({ database: main, models, config: { databases: { orders } } });
  running.push(app);
  const send = async (method: string, path: string, body?: unknown) => app.fetch(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const create = async (path: string, body: unknown) => (await (await send("POST", path, body)).json()) as { id: string } & Record<string, unknown>;
  return { app, send, create };
}

describe("constraints", () => {
  test("a reference across databases creates no foreign key, one in the same database does", async () => {
    for (const ddl of [await postgresDdl([customer, tag, order, line]), await sqliteDdl([customer, tag, order, line])]) {
      const text = ddl.join("\n");
      expect(text).not.toMatch(/REFERENCES (?:"public"\.)?[`"]customers/);
      expect(text).not.toMatch(/REFERENCES (?:"public"\.)?[`"]tags/);
      expect(text).toMatch(/REFERENCES (?:"public"\.)?[`"]orders/);
    }
  });

  test("each reference across databases is listed once with its build line", () => {
    expect(crossDatabaseReferences(models).map(crossDatabaseWarning)).toEqual([
      "Order.customer references Customer in database default; there is no database-level integrity or cascade for it",
      "Order.tags references Tag in database default; there is no database-level integrity or cascade for it",
    ]);
  });
});

describe("existence checks", () => {
  test("create, update and replace check the referenced records in their own database", async () => {
    const { send, create } = await start();
    const ada = await create("/customers", { name: "Ada" });
    const pen = await create("/tags", { label: "pen" });
    const missing = await send("POST", "/orders", { number: "A-1", customer: "nope" });
    expect(await errorOf(missing)).toEqual({ status: 400, code: "VALIDATION_ERROR", message: "Invalid body" });
    expect(((await (await send("POST", "/orders", { number: "A-1", customer: "nope", tags: ["x"] })).json()) as { error: { details: unknown[] } }).error.details).toEqual([
      { field: "tags[0]", message: "Referenced record not found" },
      { field: "customer", message: "Referenced record not found" },
    ]);
    const created = await create("/orders", { number: "A-1", customer: ada.id, tags: [pen.id] });
    expect(created.customer).toBe(ada.id);
    expect((await send("PATCH", `/orders/${created.id}`, { customer: "nope" })).status).toBe(400);
    expect((await send("PUT", `/orders/${created.id}`, { number: "A-2", customer: "nope" })).status).toBe(400);
    expect((await send("PUT", `/orders/${created.id}`, { number: "A-2", customer: ada.id })).status).toBe(200);
  });
});

describe("delete rules", () => {
  test("restrict is checked in the referencing database and answers 409", async () => {
    const { send, create } = await start();
    const ada = await create("/customers", { name: "Ada" });
    const bob = await create("/customers", { name: "Bob" });
    await create("/orders", { number: "A-1", customer: ada.id });
    expect(await errorOf(await send("DELETE", `/customers/${ada.id}`))).toEqual({ status: 409, code: "CONFLICT", message: "Cannot delete: referenced by orders" });
    expect((await send("DELETE", `/customers/${bob.id}`)).status).toBe(204);
  });

  test("a reference array in another database loses the deleted id, and a cascade in one database still works", async () => {
    const orders = memoryAdapter();
    const { send, create } = await start(memoryAdapter(), orders);
    const pen = await create("/tags", { label: "pen" });
    const ink = await create("/tags", { label: "ink" });
    const placed = await create("/orders", { number: "A-1", tags: [pen.id, ink.id] });
    await create("/lines", { order: placed.id });
    expect((await send("DELETE", `/tags/${pen.id}`)).status).toBe(204);
    expect(((await (await send("GET", `/orders/${placed.id}`)).json()) as { tags: string[] }).tags).toEqual([ink.id]);
    expect((await send("DELETE", `/orders/${placed.id}`)).status).toBe(204);
    expect(await orders.count(line, [])).toBe(0);
  });
});

describe("populate", () => {
  test("references in another database are loaded with one query per path for the page", async () => {
    const calls: string[] = [];
    const { send, create } = await start(spied(memoryAdapter(), calls));
    const ada = await create("/customers", { name: "Ada" });
    const bob = await create("/customers", { name: "Bob" });
    for (const [index, owner] of [ada, bob, ada].entries()) await create("/orders", { number: `A-${index}`, customer: owner.id });
    calls.length = 0;
    const page = (await (await send("GET", "/orders?populate=customer&sort=number")).json()) as { data: { customer: { name: string } }[] };
    expect(page.data.map((item) => item.customer.name)).toEqual(["Ada", "Bob", "Ada"]);
    expect(calls).toEqual(["Customer"]);
  });
});
