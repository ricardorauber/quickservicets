import { describe, expect, test } from "bun:test";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const CONFIG = `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ databases: { orders: memoryAdapter() } });
`;
const CUSTOMER = "export type Customer = { name: string };\n";

describe("references across databases", () => {
  test("build with one warning per reference whose target lives in another database", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": CONFIG,
      "entities/Customer.ts": CUSTOMER,
      "entities/Tag.ts": "export type Tag = { label: string };\n",
      "entities/orders/Order.ts": 'import type { Customer } from "../Customer.ts";\nimport type { Tag } from "../Tag.ts";\nexport type Order = { number: string; customer: Customer; tags?: Tag[] };\n',
      "entities/orders/Line.ts": 'import type { Order } from "./Order.ts";\nexport type Line = {\n  /** @onDelete cascade */\n  order: Order;\n};\n',
    });
    const summary = await build(root, {});
    expect(summary.warnings.filter((warning) => warning.includes("database-level"))).toEqual([
      "Order.customer references Customer in database default; there is no database-level integrity or cascade for it",
      "Order.tags references Tag in database default; there is no database-level integrity or cascade for it",
    ]);
  });

  test("cascade and setNull across databases fail the build", async () => {
    for (const rule of ["cascade", "setNull"]) {
      const root = createLinkedProject({
        "quickservicets.config.ts": CONFIG,
        "entities/Customer.ts": CUSTOMER,
        "entities/orders/Order.ts": `import type { Customer } from "../Customer.ts";\nexport type Order = {\n  /** @onDelete ${rule} */\n  customer?: Customer;\n};\n`,
      });
      await expect(build(root, {})).rejects.toThrow(
        `entities/orders/Order.ts: @onDelete ${rule} is not available across databases (Order in orders, Customer in default); use restrict, or a listener or saga to clean up`,
      );
    }
  });

  test("relations kept in sync on both sides need both entities in one database", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": CONFIG,
      "entities/Customer.ts": 'import type { Order } from "./orders/Order.ts";\nexport type Customer = {\n  /** @inverse customers */\n  orders?: Order[];\n};\n',
      "entities/orders/Order.ts": 'import type { Customer } from "../Customer.ts";\nexport type Order = {\n  /** @inverse orders */\n  customers?: Customer[];\n};\n',
    });
    await expect(build(root, {})).rejects.toThrow(/^entities\/(Customer|orders\/Order)\.ts: @inverse needs both entities in one database$/);
    const owned = createLinkedProject({
      "quickservicets.config.ts": CONFIG,
      "entities/Customer.ts": 'import type { Order } from "./orders/Order.ts";\nexport type Customer = {\n  /** @owner */\n  lastOrder?: Order;\n};\n',
      "entities/orders/Order.ts": 'import type { Customer } from "../Customer.ts";\nexport type Order = {\n  /** @inverse lastOrder */\n  buyer?: Customer;\n};\n',
    });
    await expect(build(owned, {})).rejects.toThrow(/: @owner needs both entities in one database$/);
  });
});
