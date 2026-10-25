import { afterEach, describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entityModel, field } from "./entity-model.ts";
import { registerProjectFeatures } from "./features.ts";
import { events } from "./features/events/bus.ts";
import { queueMessageEntity } from "./features/queues/message.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import "./index.ts";

const logger = { info: (_entry: LogEntry) => {}, warn: (_entry: LogEntry) => {}, error: (_entry: LogEntry) => {} };
afterEach(() => registerProjectFeatures([]));

const user = entityModel("User", { name: field({ type: "string" }) });

async function serve(config: Record<string, unknown>, env: Record<string, string> = {}, database: DatabaseAdapter = memoryAdapter()) {
  const resolved = resolveConfig({ database, logger, ...config } as ServiceConfig, env);
  const models = [user, ...(resolved.features.some((feature) => feature.key === "queues") ? [queueMessageEntity()] : [])];
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await database.connect(models);
  const app = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config: resolved, runtimeRoutes: lifecycle.routes, middleware: lifecycle.middleware, server: lifecycle.server });
  await lifecycle.start({ repos: app.repos as never, server: app.server });
  return {
    get: async (path: string, headers: Record<string, string> = {}) => {
      const response = await app.server.fetch(new Request(`http://localhost${path}`, { headers }));
      return [response.status, (await response.json()) as any] as const;
    },
    async stop() {
      await lifecycle.shutdown();
      await app.shutdown();
      await lifecycle.stop();
      await database.disconnect();
    },
  };
}

/** A memory adapter whose ping fails while `down.value` is true, counting its calls. */
function switchable() {
  const database = memoryAdapter();
  const state = { down: false, pings: 0 };
  database.ping = async () => {
    state.pings++;
    if (state.down) throw new Error("connection refused");
  };
  return { database, state };
}

describe("variables", () => {
  test("QS_HEALTH_READY moves the route, QS_HEALTH_DETAILS shows errors in production, QS_HEALTH_ENABLED=false removes both routes", async () => {
    const moved = await serve({ health: {} }, { QS_HEALTH_READY: "/ready" });
    try {
      expect((await moved.get("/ready"))[0]).toBe(200);
      expect((await moved.get("/health/ready"))[0]).toBe(404);
    } finally {
      await moved.stop();
    }
    const { database, state } = switchable();
    state.down = true;
    const production = await serve({ production: true, health: { drainDelay: "0s" } }, { QS_HEALTH_DETAILS: "true" }, database);
    try {
      expect((await production.get("/health/ready"))[1].checks.database.error).toBe("connection refused");
    } finally {
      await production.stop();
    }
    const off = await serve({ health: {} }, { QS_HEALTH_ENABLED: "false" });
    try {
      expect((await off.get("/health/live"))[0]).toBe(404);
      expect((await off.get("/health/ready"))[0]).toBe(404);
    } finally {
      await off.stop();
    }
  });

  test("a details function shows details only to probes with the token, and the checks run once per cache period", async () => {
    const { database, state } = switchable();
    state.down = true;
    const service = await serve({ production: true, health: { drainDelay: "0s", details: ({ req }: { req?: { headers: Headers } }) => req?.headers.get("x-probe-token") === "secret" } }, {}, database);
    try {
      expect((await service.get("/health/ready", { "x-probe-token": "secret" }))[1].checks.database.error).toBe("connection refused");
      expect((await service.get("/health/ready"))[1].checks.database.error).toBeUndefined();
      expect(state.pings).toBe(1);
    } finally {
      await service.stop();
    }
  });
});

describe("hooks and events", () => {
  test("beforeCheck returning false skips a check; onStatusChange and the event fire when the database goes down and returns", async () => {
    const { database, state } = switchable();
    const changes: { from: string; to: string }[] = [];
    const service = await serve(
      {
        events: {},
        queues: { consume: false },
        health: {
          cache: "0s",
          beforeCheck: (step: { name: string } | false) => (step && step.name === "queue" ? false : undefined),
          onStatusChange: ({ from, to }: { from: string; to: string }) => void changes.push({ from, to }),
        },
      },
      {},
      database,
    );
    const emitted: unknown[] = [];
    const off = events.on("health.status.changed", (event) => void emitted.push((event as { payload: unknown }).payload));
    try {
      const [, body] = await service.get("/health/ready");
      expect(body.checks.queue).toEqual({ status: "skipped", durationMs: 0, critical: false });
      state.down = true;
      expect((await service.get("/health/ready"))[0]).toBe(503);
      await service.get("/health/ready");
      state.down = false;
      expect((await service.get("/health/ready"))[0]).toBe(200);
      expect(changes).toEqual([
        { from: "ok", to: "fail" },
        { from: "fail", to: "ok" },
      ]);
      await events.idle();
      expect(emitted).toEqual([
        { from: "ok", to: "fail", failing: ["database"] },
        { from: "fail", to: "ok", failing: [] },
      ]);
    } finally {
      off();
      await service.stop();
    }
  });

  test("afterCheck sees each check's result", async () => {
    const seen: unknown[] = [];
    const service = await serve({ health: { afterCheck: (done: unknown) => void seen.push(done) } });
    try {
      await service.get("/health/ready");
      expect(seen).toEqual([{ name: "database", status: "ok", durationMs: expect.any(Number) }]);
    } finally {
      await service.stop();
    }
  });
});

describe("the prober", () => {
  test("a prober's result is the ready response; an object without run is a configuration error", async () => {
    const prober = { run: () => ({ status: "degraded", checks: { custom: { status: "fail", durationMs: 0, critical: false, error: "fixed" } } }) };
    const service = await serve({ health: { prober } });
    try {
      expect(await service.get("/health/ready")).toEqual([200, { status: "degraded", checks: { custom: { status: "fail", durationMs: 0, critical: false, error: "fixed" } } }]);
    } finally {
      await service.stop();
    }
    expect(() => resolveConfig({ database: memoryAdapter(), health: { prober: { probe() {} } } } as unknown as ServiceConfig, {})).toThrow(/Invalid health\.prober: /);
  });
});
