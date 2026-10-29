import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityModel } from "@quickservicets/core";
import { envCheck } from "../env/env-check.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const CONFIG = `import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ databases: { orders: sqliteAdapter({ path: ":memory:" }), catalog: memoryAdapter() } });
`;
const ENTITIES = {
  "entities/orders/Order.ts": "export type Order = { number: string };\n",
  "entities/orders/Note.ts": "/** @database default */\nexport type Note = { text: string };\n",
  "entities/Product.ts": "/** @database catalog */\nexport type Product = { name: string };\n",
  "entities/Customer.ts": "export type Customer = { name: string };\n",
};

const modelsOf = async (root: string): Promise<EntityModel[]> => (await import(join(root, ".generated/models.ts"))).models;
const databaseOf = (models: EntityModel[], key: string) => models.find((model) => model.key === key)?.database;

describe("placing entities in databases", () => {
  test("a module folder named like a database places its entities there unless @database says otherwise", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": CONFIG, ...ENTITIES });
    await build(root, {});
    const models = await modelsOf(root);
    expect(databaseOf(models, "orders/Order")).toBe("orders");
    expect(databaseOf(models, "orders/Note")).toBe("default");
    expect(databaseOf(models, "Product")).toBe("catalog");
    expect(databaseOf(models, "Customer")).toBe("default");
  });

  test("without databases no model records one", async () => {
    const root = createLinkedProject({ "entities/orders/Order.ts": "export type Order = { number: string };\n" });
    await build(root, {});
    expect((await modelsOf(root)).map((model) => model.database)).toEqual([undefined]);
  });

  test("an unknown database fails the build naming the file and the configured names", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": CONFIG, "entities/Product.ts": "/** @database nope */\nexport type Product = { name: string };\n" });
    await expect(build(root, {})).rejects.toThrow("entities/Product.ts: unknown database nope (configured: default, orders, catalog)");
  });

  test("routes, types and the API document do not change with the database", async () => {
    const placed = createLinkedProject({ "quickservicets.config.ts": CONFIG, ...ENTITIES });
    const single = createLinkedProject({ ...ENTITIES, "entities/Product.ts": "export type Product = { name: string };\n", "entities/orders/Note.ts": "export type Note = { text: string };\n" });
    await build(placed, {});
    await build(single, {});
    for (const file of ["openapi.json", "routes.ts", "types.ts"]) expect(readFileSync(join(placed, ".generated", file), "utf8")).toBe(readFileSync(join(single, ".generated", file), "utf8"));
  });
});

test("a project serves every module from its own database with unchanged repositories", async () => {
  const config = 'import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ databases: { orders: memoryAdapter(), catalog: memoryAdapter() } });\n';
  const service = await startTestService({ files: { "quickservicets.config.ts": config, ...ENTITIES } });
  try {
    const post = (path: string, body: unknown) => service.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const order = (await (await post("/orders/orders", { number: "A-1" })).json()) as { id: string };
    expect((await post("/products", { name: "Pen" })).status).toBe(201);
    const repos = service.repos as unknown as { orders: { orders: { findById(id: string): Promise<{ number: string } | null> } } };
    expect((await repos.orders.orders.findById(order.id))?.number).toBe("A-1");
    expect(((await (await service.fetch("/products")).json()) as { total: number }).total).toBe(1);
  } finally {
    await service.stop();
  }
});

describe("operations", () => {
  test("env check reports QS_DATABASES_<NAME>_URL as set, masked", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": CONFIG });
    const result = await envCheck(root, { QS_DATABASES_ORDERS_URL: "other.db" });
    expect(result.lines).toContain("QS_DATABASES_ORDERS_URL sets databases.orders.url = [secret]");
    expect(result.lines.join("\n")).not.toContain("other.db");
    const memory = await envCheck(root, { QS_DATABASES_CATALOG_URL: "x" });
    expect(memory.code).not.toBe(0);
    expect(memory.errors).toContain("QS_DATABASES_CATALOG_URL cannot be used with the memory adapter");
  });

  test("a command that connects exits 4 naming an unreachable database without its password", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": `import { defineConfig, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ databases: { orders: postgresAdapter({ url: "postgres://app:hunter2@127.0.0.1:1/orders" }) } });
`,
      "entities/orders/Order.ts": "export type Order = { number: string };\n",
      "jobs/report.ts": 'import { job } from "@quickservicets/core";\nexport default job("@daily", async () => ({}));\n',
    });
    const err: string[] = [];
    const code = await run(["job", "runs", "report"], { log: () => {}, error: (line) => void err.push(line) }, root);
    expect(code).toBe(4);
    expect(err.join("\n")).toContain("Cannot connect database orders (postgres): ");
    expect(err.join("\n")).not.toContain("hunter2");
  });
});
