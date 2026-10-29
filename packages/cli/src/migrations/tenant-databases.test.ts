import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { build } from "../build/build.ts";
import { createLinkedProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";
import { migrate, migrateTenants } from "./migrate.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, seconds));

/** A tenancy project: a default SQLite database, a per-tenant SQLite `orders` and a shared memory `catalog`. */
function project(files: Record<string, string> = {}) {
  const root = createLinkedProject({
    "entities/Note.ts": "export type Note = { text: string };\n",
    "entities/orders/Order.ts": "export type Order = { number: string };\n",
    "entities/catalog/Product.ts": "export type Product = { name: string };\n",
    ...files,
  });
  writeFileSync(
    join(root, "quickservicets.config.ts"),
    `import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({
  database: sqliteAdapter({ path: ${JSON.stringify(join(root, "main.db"))} }),
  databases: { orders: sqliteAdapter({ path: ${JSON.stringify(join(root, "orders.db"))} }), catalog: { adapter: memoryAdapter(), tenancy: "shared" } },
  tenancy: { source: "config", tenants: { acme: {} } },
});
`,
  );
  return root;
}

describe("tenant and shared entities per database", () => {
  test("@tenancy tags against their database's tenancy fail the build", async () => {
    await expect(build(project({ "entities/orders/Order.ts": "/** @tenancy shared */\nexport type Order = { number: string };\n" }), {})).rejects.toThrow(
      "entities/orders/Order.ts: Order lives in database orders, which is per tenant; move it to a shared database or remove @tenancy shared",
    );
    await expect(build(project({ "entities/catalog/Product.ts": "/** @tenancy tenant */\nexport type Product = { name: string };\n" }), {})).rejects.toThrow(
      "entities/catalog/Product.ts: Product lives in database catalog, which is shared; move it to a per-tenant database or remove @tenancy tenant",
    );
  });

  test("the orders entities hold tenant data and the catalog ones are shared", async () => {
    const root = project();
    await build(root, {});
    const { models } = (await import(join(root, ".generated/models.ts"))) as { models: { key: string; tenancy?: string }[] };
    expect(models.filter((model) => ["orders/Order", "catalog/Product", "Note"].includes(model.key)).map((model) => [model.key, model.tenancy])).toEqual([
      ["Note", "tenant"],
      ["catalog/Product", "shared"],
      ["orders/Order", "tenant"],
    ]);
  });
});

describe("tenant migrations", () => {
  test("migrate --tenant applies the orders migrations in the tenant's copy and names the database", async () => {
    const root = project();
    await addMigration(root, "Init", at(0));
    // The root migrations skip the tenant statements of the per-tenant databases.
    expect((await migrate(root)).messages.join("\n")).toContain("Skipped");
    const result = await migrateTenants(root, { tenant: "acme" });
    expect(result.messages).toEqual(["acme: default: Applied 20261015120000_Init", "acme: orders: Applied 20261015120000_Init"]);
    const orders = new Database(join(root, "orders.db"));
    try {
      const names = (orders.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
      expect(names).toContain("tenant_acme__orders");
    } finally {
      orders.close();
    }
    expect((await migrateTenants(root, { tenant: "acme" })).messages).toEqual(["acme: Up to date"]);
  });
});
