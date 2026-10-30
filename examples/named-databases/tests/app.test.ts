/**
 * End-to-end checks of the named databases example: customers in the default database, orders and their lines in the
 * orders database. Runs on memory with `startTestService` (`bun test` in examples/named-databases), with no database
 * server; the migration check writes SQLite migration files in a temporary copy of the project.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { addMigration } from "@quickservicets/cli";
import { startTestService, type TestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const dir of ["entities", "endpoints"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type Row = { id: string } & Record<string, unknown>;

const services: TestService[] = [];
afterAll(async () => {
  for (const service of services) await service.stop();
});
async function start(): Promise<TestService> {
  const service = await startTestService({ files: exampleFiles() });
  services.push(service);
  return service;
}
const json = async (response: Response) => (await response.json()) as Row & { data: Row[]; error: { code: string; message: string; details?: unknown } };

test("CRUD in both databases, with a customer reference checked across them", async () => {
  const service = await start();
  const ada = await json(await service.fetch("/customers", send("POST", { name: "Ada" })));
  const order = await json(await service.fetch("/orders/orders", send("POST", { number: "A-1", customer: ada.id })));
  expect(order).toMatchObject({ number: "A-1", customer: ada.id, paid: false });
  expect((await service.fetch(`/orders/orders/${order.id}`, send("PATCH", { paid: true }))).status).toBe(200);
  expect((await json(await service.fetch(`/orders/orders/${order.id}`))).paid).toBe(true);
  const unknown = await service.fetch("/orders/orders", send("POST", { number: "A-2", customer: "nope" }));
  expect(unknown.status).toBe(400);
  expect((await json(unknown)).error.details).toEqual([{ field: "customer", message: "Referenced record not found" }]);
});

test("populate=customer loads customers from the default database", async () => {
  const service = await start();
  const ada = await json(await service.fetch("/customers", send("POST", { name: "Ada" })));
  await service.fetch("/orders/orders", send("POST", { number: "A-1", customer: ada.id }));
  const page = await json(await service.fetch("/orders/orders?populate=customer"));
  expect(page.data.map((row) => (row.customer as Row).name)).toEqual(["Ada"]);
});

test("a customer with orders cannot be deleted; an order's lines are deleted with it", async () => {
  const service = await start();
  const ada = await json(await service.fetch("/customers", send("POST", { name: "Ada" })));
  const order = await json(await service.fetch("/checkout", send("POST", { number: "A-1", customer: ada.id, lines: [{ sku: "pen", quantity: 2 }, { sku: "ink", quantity: 1 }] })));
  expect((await json(await service.fetch("/orders/order-lines"))).data).toHaveLength(2);
  const refused = await service.fetch(`/customers/${ada.id}`, send("DELETE"));
  expect(refused.status).toBe(409);
  expect((await json(refused)).error.code).toBe("CONFLICT");
  expect((await service.fetch(`/orders/orders/${order.id}`, send("DELETE"))).status).toBe(204);
  expect((await json(await service.fetch("/orders/order-lines"))).data).toHaveLength(0);
  expect((await service.fetch(`/customers/${ada.id}`, send("DELETE"))).status).toBe(204);
});

test("the checkout writes all its rows or none", async () => {
  const service = await start();
  const ada = await json(await service.fetch("/customers", send("POST", { name: "Ada" })));
  const failed = await service.fetch("/checkout", send("POST", { number: "A-1", customer: ada.id, lines: [{ sku: "pen", quantity: 1 }, { sku: "", quantity: 1 }] }));
  expect(failed.status).toBe(400);
  expect((await json(await service.fetch("/orders/orders"))).data).toEqual([]);
  expect((await json(await service.fetch("/orders/order-lines"))).data).toEqual([]);
});

test("a transaction touching both databases is refused", async () => {
  const service = await start();
  const repos = service.repos as unknown as {
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    customers: { create(body: unknown): Promise<Row>; count(): Promise<number> };
    orders: { orders: { create(body: unknown): Promise<Row>; count(): Promise<number> } };
  };
  const ada = await repos.customers.create({ name: "Ada" });
  const failure = await repos
    .transaction(async () => {
      await repos.orders.orders.create({ number: "A-1", customer: ada.id });
      await repos.customers.create({ name: "Bob" });
    })
    .catch((error: unknown) => error as { code: string; message: string });
  expect(failure).toMatchObject({
    code: "CROSS_DATABASE_TRANSACTION",
    message: "Cannot use Customer (database default) inside a transaction of database orders; a transaction covers one database. Use a saga or the outbox for changes across databases",
  });
  expect(await repos.orders.orders.count()).toBe(0);
  expect(await repos.customers.count()).toBe(1);
});

test("migration add writes migrations/ and migrations/orders/ for the SQLite files", async () => {
  const copy = mkdtempSync(join(tmpdir(), "named-databases-example-"));
  try {
    for (const [file, content] of Object.entries(exampleFiles())) {
      mkdirSync(dirname(join(copy, file)), { recursive: true });
      writeFileSync(join(copy, file), content);
    }
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
    const created = await addMigration(copy, "Init");
    expect(created.migrations.map((migration) => migration.database)).toEqual(["default", "orders"]);
    const [main, orders] = created.migrations.map((migration) => readFileSync(join(copy, migration.file), "utf8"));
    expect(created.migrations[1]!.file).toStartWith("migrations/orders/");
    expect(main).toContain("customers");
    expect(main).not.toContain("order_lines");
    expect(orders).toContain("order_lines");
    expect(existsSync(join(copy, "migrations/orders/meta"))).toBe(true);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
