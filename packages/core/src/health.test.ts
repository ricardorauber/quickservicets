import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entityModel, field } from "./entity-model.ts";
import { registerProjectFeatures } from "./features.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import type { EntityModel } from "./model.ts";
import { queueMessageEntity } from "./features/queues/message.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";
import "./index.ts";

const logs: (LogEntry & { level: string })[] = [];
const logger = { info: (entry: LogEntry) => void logs.push({ level: "info", ...entry }), warn: (entry: LogEntry) => void logs.push({ level: "warn", ...entry }), error: (entry: LogEntry) => void logs.push({ level: "error", ...entry }) };
afterEach(() => {
  logs.length = 0;
  registerProjectFeatures([]);
});

const user = entityModel("User", { name: field({ type: "string" }) });

/** A running app of `config` over `database`, with the features' routes, without a listener. */
async function serve(config: Record<string, unknown>, options: { database?: DatabaseAdapter; models?: EntityModel[]; prepare?: (adapter: DatabaseAdapter, models: EntityModel[]) => Promise<void> } = {}) {
  const database = options.database ?? memoryAdapter();
  const resolved = resolveConfig({ database, logger, ...config } as ServiceConfig, {});
  const models = [...(options.models ?? [user]), ...(resolved.features.some((feature) => feature.key === "queues") ? [queueMessageEntity()] : [])];
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await database.connect(models);
  await options.prepare?.(database, models);
  const app = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config: resolved, runtimeRoutes: lifecycle.routes, middleware: lifecycle.middleware, server: lifecycle.server });
  await lifecycle.start({ repos: app.repos as never, server: app.server });
  return {
    fetch: (path: string) => app.server.fetch(new Request(`http://localhost${path}`), { peer: "203.0.113.9" }),
    async stop() {
      await lifecycle.shutdown();
      await app.shutdown();
      await lifecycle.stop();
      await database.disconnect();
    },
  };
}

// The ready body, loosely typed for the assertions.
const json = async (response: Response) => [response.status, (await response.json()) as any] as const;

describe("liveness and readiness", () => {
  test("live answers ok without a check; ready lists the database check", async () => {
    let pings = 0;
    const database = memoryAdapter();
    const ping = database.ping!.bind(database);
    database.ping = async () => {
      pings++;
      return ping();
    };
    const service = await serve({ health: {} }, { database });
    try {
      expect(await json(await service.fetch("/health/live"))).toEqual([200, { status: "ok" }]);
      expect(pings).toBe(0);
      const [status, body] = await json(await service.fetch("/health/ready"));
      expect(status).toBe(200);
      expect(body).toEqual({ status: "ok", checks: { database: { status: "ok", durationMs: expect.any(Number), critical: true } } });
      expect(pings).toBe(1);
    } finally {
      await service.stop();
    }
  });

  test("without health no route exists", async () => {
    const service = await serve({});
    try {
      expect((await service.fetch("/health/live")).status).toBe(404);
    } finally {
      await service.stop();
    }
  });
});

describe("adapters", () => {
  const adapters: [string, () => DatabaseAdapter, ((adapter: DatabaseAdapter, models: EntityModel[]) => Promise<void>)?][] = [
    ["memory", () => memoryAdapter()],
    ["sqlite", () => sqliteAdapter({ path: join(mkdtempSync(join(tmpdir(), "qs-health-")), "db.sqlite") }), (adapter, models) => createSqliteTables((adapter as never as { client: never }).client, models)],
  ];
  if (process.env.TEST_POSTGRES_URL) adapters.push(["postgres", () => postgresAdapter({ url: process.env.TEST_POSTGRES_URL! }), (adapter, models) => resetPostgresTables((adapter as never as { client: never }).client, models)]);
  if (process.env.TEST_MONGODB_URL) adapters.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `qs_health_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
  for (const [name, create, prepare] of adapters) {
    test(`${name}: ping resolves and ready reports the database ok`, async () => {
      const database = create();
      expect(typeof database.ping).toBe("function");
      const service = await serve({ health: {} }, { database, ...(prepare ? { prepare } : {}) });
      try {
        await database.ping!();
        const [status, body] = await json(await service.fetch("/health/ready"));
        expect([status, body.checks.database.status]).toEqual([200, "ok"]);
      } finally {
        await service.stop();
      }
    });
  }

  test("an adapter without ping is checked by reading one record", async () => {
    const database = memoryAdapter();
    let reads = 0;
    const findMany = database.findMany.bind(database);
    database.findMany = (entity, options) => {
      reads++;
      expect(options).toMatchObject({ limit: 1, withTotal: false });
      return findMany(entity, options);
    };
    (database as { ping?: unknown }).ping = undefined;
    const service = await serve({ health: {} }, { database });
    try {
      expect((await service.fetch("/health/ready")).status).toBe(200);
      expect(reads).toBe(1);
    } finally {
      await service.stop();
    }
  });
});

describe("results", () => {
  test("a failing database gives 503 fail; a ping that never resolves fails after the timeout", async () => {
    const down = memoryAdapter();
    down.ping = async () => {
      throw new Error("connection refused");
    };
    const failing = await serve({ health: {} }, { database: down });
    try {
      const [status, body] = await json(await failing.fetch("/health/ready"));
      expect([status, body.status, body.checks.database]).toEqual([503, "fail", { status: "fail", durationMs: expect.any(Number), critical: true, error: "connection refused" }]);
    } finally {
      await failing.stop();
    }
    const stuck = memoryAdapter();
    stuck.ping = () => new Promise(() => {});
    const slow = await serve({ health: { timeout: "1s" } }, { database: stuck });
    try {
      const started = Date.now();
      const [status, body] = await json(await slow.fetch("/health/ready"));
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      expect([status, body.checks.database.error]).toEqual([503, "Timed out after 1s"]);
    } finally {
      await slow.stop();
    }
  });

  test("the queue check is non-critical with waiting messages, and a failing broker health degrades readiness", async () => {
    const service = await serve({ health: {}, queues: {} });
    try {
      const [, body] = await json(await service.fetch("/health/ready"));
      expect(body.checks.queue).toEqual({ status: "ok", durationMs: expect.any(Number), critical: false, waiting: 0, oldestWaitingMs: null });
    } finally {
      await service.stop();
    }
    const broker = { name: "flaky", enqueue: async () => ({ id: "x", deduplicated: false }), start() {}, stop: async () => {}, stats: async () => ({}), health: async () => Promise.reject(new Error("broker unreachable")) };
    const degraded = await serve({ health: {}, queues: { broker } });
    try {
      const [status, body] = await json(await degraded.fetch("/health/ready"));
      expect([status, body.status, body.checks.queue.error]).toEqual([200, "degraded", "broker unreachable"]);
    } finally {
      await degraded.stop();
    }
  });

  test("in production a failing check has no error in the response and is logged as health.check.failed", async () => {
    const down = memoryAdapter();
    down.ping = async () => {
      throw new Error("connection refused");
    };
    const service = await serve({ health: {}, production: true }, { database: down });
    try {
      const [status, body] = await json(await service.fetch("/health/ready"));
      expect([status, body.checks.database]).toEqual([503, { status: "fail", durationMs: expect.any(Number), critical: true }]);
      expect(logs.find((entry) => entry.message === "health.check.failed")).toMatchObject({ check: "database", error: { message: "connection refused" } });
    } finally {
      await service.stop();
    }
  });
});

describe("caching and logs", () => {
  test("probes within the cache period run the checks once; 0s runs them each time", async () => {
    const counted = async (cache: string) => {
      const database = memoryAdapter();
      let pings = 0;
      database.ping = async () => {
        pings++;
        await Bun.sleep(5);
      };
      const service = await serve({ health: { cache } }, { database });
      try {
        await Promise.all(Array.from({ length: 10 }, () => service.fetch("/health/ready")));
        return pings;
      } finally {
        await service.stop();
      }
    };
    expect(await counted("1s")).toBe(1);
    expect(await counted("0s")).toBe(10);
  });

  test("probes write no request log entry unless they fail with 5xx or log is on", async () => {
    const requests = () => logs.filter((entry) => entry.route?.toString().startsWith("/health"));
    const service = await serve({ health: {} });
    try {
      await service.fetch("/health/live");
      await service.fetch("/health/ready");
      expect(requests()).toEqual([]);
    } finally {
      await service.stop();
    }
    const down = memoryAdapter();
    down.ping = async () => {
      throw new Error("down");
    };
    const failing = await serve({ health: {} }, { database: down });
    try {
      await failing.fetch("/health/ready");
      expect(requests().map((entry) => entry.status)).toEqual([503]);
    } finally {
      await failing.stop();
    }
    logs.length = 0;
    const logged = await serve({ health: { log: true } });
    try {
      await logged.fetch("/health/live");
      await logged.fetch("/health/ready");
      expect(requests().map((entry) => entry.status)).toEqual([200, 200]);
    } finally {
      await logged.stop();
    }
  });
});

describe("security", () => {
  test("with a rate limit of 1/min, a hundred probes from one address all answer 200", async () => {
    const service = await serve({ health: {}, security: { rateLimit: { limit: "1/min" } } });
    try {
      const statuses = await Promise.all(Array.from({ length: 100 }, (_, index) => service.fetch(index % 2 ? "/health/live" : "/health/ready").then((response) => response.status)));
      expect(statuses.every((status) => status === 200)).toBe(true);
    } finally {
      await service.stop();
    }
  });
});
