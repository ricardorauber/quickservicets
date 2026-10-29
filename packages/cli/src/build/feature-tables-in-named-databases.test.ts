import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readOutbox, type DatabaseAdapter, type EntityModel, type StoredRecord } from "@quickservicets/core";
import { referencePages } from "../../../../docs/scripts/reference.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

/** A config whose named `orders` memory database the test reads, through `globalThis.ordersDb`. */
const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
const orders = memoryAdapter();
(globalThis as { ordersDb?: unknown }).ordersDb = orders;
export default defineConfig({ databases: { orders }, ${keys} });
`;
const ENTITIES = {
  "entities/Customer.ts": "export type Customer = { name: string };\n",
  "entities/orders/Order.ts": "export type Order = { number: string };\n",
};
const TRACKED = { ...ENTITIES, "entities/orders/Order.ts": "/** @history */\nexport type Order = { number: string };\n" };
const ordersDb = () => (globalThis as unknown as { ordersDb: DatabaseAdapter }).ordersDb;
const modelsOf = async (root: string): Promise<EntityModel[]> => (await import(join(root, ".generated/models.ts"))).models;
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("derived feature entities", () => {
  test("the history of an orders entity lives in orders and is written in the order's transaction", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("events: {}, history: {}"), ...TRACKED } });
    try {
      const models = await modelsOf(service.root);
      const history = models.find((model) => model.key === "OrderHistory")!;
      expect(history.database).toBe("orders");
      const order = (await (await service.fetch("/orders/orders", post({ number: "A-1" }))).json()) as { id: string };
      expect(await ordersDb().count(history, [])).toBe(1);
      expect((await ordersDb().findMany(history, { where: [], sort: [], limit: 1, offset: 0 })).data[0]).toMatchObject({ entityId: order.id });
    } finally {
      await service.stop();
    }
  });
});

describe("per-database entities", () => {
  test("each database with entities gets the outbox, written in its own transactions, and readers see both", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("events: { outbox: true }"), ...ENTITIES } });
    try {
      const models = await modelsOf(service.root);
      const outbox = models.find((model) => model.key === "OutboxEvent")!;
      expect(outbox).toMatchObject({ perDatabase: true, database: "default" });
      expect((await service.fetch("/customers", post({ name: "Ada" }))).status).toBe(201);
      expect((await service.fetch("/orders/orders", post({ number: "A-1" }))).status).toBe(201);
      const inOrders = (await ordersDb().findMany(outbox, { where: [], sort: [], limit: 10, offset: 0 })).data as StoredRecord[];
      expect(inOrders.map((row) => row.type)).toEqual(["order.created"]);
      expect((await readOutbox()).map((record) => record.type).sort()).toEqual(["customer.created", "order.created"]);
    } finally {
      await service.stop();
    }
  });
});

describe("the database option of features", () => {
  test("queues: { database } moves the queue table, QS_QUEUES_DATABASE moves it back, and an unknown name fails", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config('queues: { database: "orders" }'), ...ENTITIES });
    await build(root, {});
    expect((await modelsOf(root)).find((model) => model.key === "QueueMessage")?.database).toBe("orders");
    const back = createLinkedProject({ "quickservicets.config.ts": config('queues: { database: "orders" }'), ...ENTITIES });
    await build(back, { QS_QUEUES_DATABASE: "default" });
    expect((await modelsOf(back)).find((model) => model.key === "QueueMessage")?.database).toBe("default");
    const unknown = createLinkedProject({ "quickservicets.config.ts": config('queues: { database: "nope" }'), ...ENTITIES });
    await expect(build(unknown, {})).rejects.toThrow("Invalid queues.database: unknown database nope (configured: default, orders)");
  });
});

describe("reference pages", () => {
  test("the queues and history pages show the database option and where each entity lives", () => {
    const pages = referencePages();
    const queues = pages["reference/features/queues.mdx"]!;
    const history = pages["reference/features/history.mdx"]!;
    expect(queues).toContain("| `queues.database` | `string` | — | `QS_QUEUES_DATABASE` |");
    expect(queues).toContain("| `QueueMessage` | the feature's `database` (default: the default database) |");
    expect(history).toContain("| `history.database` | `string` | — | `QS_HISTORY_DATABASE` |");
    expect(history).toContain("| `<Entity>History` | the database of the entity it belongs to |");
  });
});
