import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAdapter, sqliteAdapter, startService, type DatabaseAdapter, type LogEntry } from "@quickservicets/core";
import { envCheck } from "../env/env-check.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const ENTITIES = {
  "entities/Customer.ts": "export type Customer = { name: string };\n",
  "entities/orders/Order.ts": "export type Order = { number: string };\n",
  "entities/orders/Line.ts": "export type Line = { sku: string };\n",
};
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("readiness", () => {
  test("one critical check per database: an unreachable orders makes the service not ready and is named", async () => {
    const config = `import { defineConfig, memoryAdapter } from "@quickservicets/core";
const orders = memoryAdapter();
(globalThis as { ordersHealth?: unknown }).ordersHealth = orders;
export default defineConfig({ databases: { orders }, health: { cache: "0s" } });
`;
    const service = await startTestService({ files: { "quickservicets.config.ts": config, ...ENTITIES }, databases: "config" });
    try {
      const first = (await (await service.fetch("/health/ready")).json()) as { status: string; checks: Record<string, unknown> };
      expect(Object.keys(first.checks)).toEqual(expect.arrayContaining(["database", "database:orders"]));
      const orders = (globalThis as unknown as { ordersHealth: DatabaseAdapter }).ordersHealth;
      orders.ping = async () => {
        throw new Error("connection refused");
      };
      const response = await service.fetch("/health/ready");
      expect(response.status).toBe(503);
      const body = (await response.json()) as { checks: Record<string, { status: string }> };
      expect(body.checks["database:orders"]?.status).toBe("fail");
      expect(body.checks.database?.status).toBe("ok");
    } finally {
      await service.stop();
    }
  }, 20_000);
});

describe("the test harness", () => {
  const POSTGRES = `import { defineConfig, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ databases: { orders: postgresAdapter({ url: "postgres://app:secret@127.0.0.1:1/orders" }) } });
`;

  test("a project whose orders is PostgreSQL runs on memory without a server", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": POSTGRES, ...ENTITIES } });
    try {
      expect((await service.fetch("/orders/orders", post({ number: "A-1" }))).status).toBe(201);
      const repos = service.repos as unknown as { orders: { orders: { count(): Promise<number> } } };
      expect(await repos.orders.orders.count()).toBe(1);
    } finally {
      await service.stop();
    }
  });

  test("databases: { orders } replaces the memory adapter, here with SQLite", async () => {
    const orders = sqliteAdapter({ path: ":memory:" });
    const connect = orders.connect.bind(orders);
    let connected: string[] = [];
    orders.connect = async (models, options) => {
      connected = models.map((model) => model.key);
      return connect(models, options);
    };
    const service = await startTestService({ files: { "quickservicets.config.ts": POSTGRES, ...ENTITIES }, databases: { orders } });
    try {
      expect(connected.sort()).toEqual(["orders/Line", "orders/Order"]);
    } finally {
      await service.stop();
    }
  });
});

describe("the startup report", () => {
  test("lists each database with its kind and entity count, and no connection", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": `import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), databases: { orders: sqliteAdapter({ path: ":memory:" }) } });
`,
      ...ENTITIES,
    });
    await build(root, {});
    const entries: LogEntry[] = [];
    const logger = { info: (entry: LogEntry) => void entries.push(entry), warn() {}, error() {} };
    const generated = join(root, ".generated");
    const { models } = await import(join(generated, "models.ts"));
    const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
    const running = await startService({
      projectConfig: { database: memoryAdapter(), databases: { orders: sqliteAdapter({ path: ":memory:" }) }, logger, server: { port: 40_000 + Math.floor(Math.random() * 20_000) } },
      models,
      crudRoutes,
      endpoints,
      hooks,
      env: { QS_DATABASES_ORDERS_URL: ":memory:" },
      process: { on() {}, once() {}, off() {}, exit() {} } as never,
      generatedDir: generated,
    });
    try {
      const lines = entries.map((entry) => entry.message).filter((message) => String(message).startsWith("databases:"));
      expect(lines).toEqual(["databases: default memory (1 entity), orders sqlite (2 entities)"]);
      expect(JSON.stringify(entries)).not.toContain("QS_DATABASES");
    } finally {
      await running?.stop();
    }
  });
});

describe("environment listings and the API document", () => {
  const CONFIG = `import { defineConfig, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ databases: { orders: sqliteAdapter({ path: ":memory:" }) } });
`;

  test(".env.example and env check list QS_DATABASES_ORDERS_URL as an optional secret naming its database", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": CONFIG, ...ENTITIES });
    await build(root, {});
    expect(readFileSync(join(root, ".env.example"), "utf8")).toContain(
      "# The connection of the named database orders, over the adapter of databases.orders\n# Type: secret\n# optional\nQS_DATABASES_ORDERS_URL=",
    );
    expect((await envCheck(root, {})).lines).toContain("QS_DATABASES_ORDERS_URL ok (not set)");
    expect((await envCheck(root, { QS_DATABASES_ORDERS_URL: "other.db" })).lines).toContain("QS_DATABASES_ORDERS_URL ok [secret]");
  });

  test("/openapi.json is byte-identical with and without databases", async () => {
    const placed = createLinkedProject({ "quickservicets.config.ts": CONFIG, ...ENTITIES });
    const single = createLinkedProject({ ...ENTITIES });
    await build(placed, {});
    await build(single, {});
    expect(readFileSync(join(placed, ".generated/openapi.json"), "utf8")).toBe(readFileSync(join(single, ".generated/openapi.json"), "utf8"));
    const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG, ...ENTITIES } });
    const plain = await startTestService({ files: { ...ENTITIES } });
    try {
      expect(await (await service.fetch("/openapi.json")).text()).toBe(await (await plain.fetch("/openapi.json")).text());
    } finally {
      await service.stop();
      await plain.stop();
    }
  });
});

void memoryAdapter;
