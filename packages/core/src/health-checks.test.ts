import { afterEach, describe, expect, test } from "bun:test";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entityModel, field } from "./entity-model.ts";
import { defineFeature, registerProjectFeatures, type FeatureDefinition } from "./features.ts";
import { createFeatureLifecycle, notifyShutdownSignal } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import "./index.ts";

const logger = { info: (_entry: LogEntry) => {}, warn: (_entry: LogEntry) => {}, error: (_entry: LogEntry) => {} };
afterEach(() => registerProjectFeatures([]));

const user = entityModel("User", { name: field({ type: "string" }) });

/** Sets up an app of `config` with project `features`; `start()` runs the onStart callbacks. */
async function prepare(config: Record<string, unknown>, features: FeatureDefinition[] = [], database: DatabaseAdapter = memoryAdapter()) {
  registerProjectFeatures(features.map((definition) => ({ folder: definition.key, definition })));
  const keys = Object.fromEntries(features.map((definition) => [definition.key, {}]));
  const resolved = resolveConfig({ database, logger, ...keys, ...config } as ServiceConfig, {});
  const models = [user];
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await database.connect(models);
  const app = createApp({
    models,
    crudRoutes: [],
    endpoints: [{ method: "GET", path: "/users", hooks: [], handler: () => ({ data: [] }) }],
    hooks: new Map(),
    config: resolved,
    runtimeRoutes: lifecycle.routes,
    middleware: lifecycle.middleware,
    server: lifecycle.server,
  });
  return {
    lifecycle,
    start: () => lifecycle.start({ repos: app.repos as never, server: app.server }),
    get: async (path: string) => {
      const response = await app.server.fetch(new Request(`http://localhost${path}`));
      return [response.status, (await response.json()) as any] as const;
    },
    async stop() {
      await lifecycle.shutdown();
      await lifecycle.stop();
      await database.disconnect();
    },
  };
}

async function serve(config: Record<string, unknown>, features: FeatureDefinition[] = []) {
  const service = await prepare(config, features);
  await service.start();
  return service;
}

const checking = (key: string, checks: (check: (name: string, fn: (input: { signal: AbortSignal }) => unknown, options?: { critical?: boolean; timeout?: string }) => void) => void) =>
  defineFeature({
    key,
    after: ["health"],
    setup(ctx) {
      checks((name, fn, options) => ctx.feature("health").check(name, fn, options));
    },
  });

describe("checks of features and the config", () => {
  test("a feature's check is listed as <key>.<name>; failing it gives 503 when critical and 200 degraded otherwise", async () => {
    let healthy = true;
    const service = await serve({ health: { cache: "0s" } }, [
      checking("example", (check) =>
        check("api", () => {
          if (!healthy) throw new Error("api down");
        }),
      ),
    ]);
    try {
      expect((await service.get("/health/ready"))[1].checks["example.api"]).toMatchObject({ status: "ok", critical: true });
      healthy = false;
      const [status, body] = await service.get("/health/ready");
      expect([status, body.status, body.checks["example.api"].error]).toEqual([503, "fail", "api down"]);
    } finally {
      await service.stop();
    }
    const soft = await serve({ health: { cache: "0s" } }, [
      checking("example", (check) =>
        check("api", () => {
          throw new Error("api down");
        }, { critical: false }),
      ),
    ]);
    try {
      const [status, body] = await soft.get("/health/ready");
      expect([status, body.status, body.checks["example.api"].critical]).toEqual([200, "degraded", false]);
    } finally {
      await soft.stop();
    }
  });

  test("config checks add their extra fields outside production only, and an object form is non-critical", async () => {
    const config = { checks: { cache: async () => ({ hits: 3 }), mail: { check: () => Promise.reject(new Error("smtp down")), critical: false } } };
    const dev = await serve({ health: config });
    try {
      const [status, body] = await dev.get("/health/ready");
      expect(status).toBe(200);
      expect(body.checks.cache).toEqual({ status: "ok", durationMs: expect.any(Number), critical: true, hits: 3 });
      expect(body.checks.mail).toMatchObject({ status: "fail", critical: false, error: "smtp down" });
    } finally {
      await dev.stop();
    }
    const production = await serve({ production: true, health: { ...config, drainDelay: "0s" } });
    try {
      expect((await production.get("/health/ready"))[1].checks.cache).toEqual({ status: "ok", durationMs: expect.any(Number), critical: true });
    } finally {
      await production.stop();
    }
  });

  test("a repeated name, or a project check named database, fails startup naming both owners", async () => {
    await expect(prepare({ health: {} }, [checking("alpha", (check) => check("api", () => {})), checking("beta", (check) => check("api", () => {}))])).rejects.toThrow(
      "Health check api is defined by alpha and beta",
    );
    await expect(prepare({ health: { checks: { database: () => {} } } })).rejects.toThrow("Health check database is defined by health and health.checks");
    await expect(prepare({ health: {} }, [checking("alpha", (check) => check("Bad Name", () => {}))])).rejects.toThrow("Invalid health check Bad Name");
  });
});

describe("signals and timeouts", () => {
  test("a check ignoring a 1s timeout sees its signal aborted after 1s and fails", async () => {
    let aborted: number | undefined;
    const started = Date.now();
    const service = await serve({ health: {} }, [
      checking("slow", (check) =>
        check(
          "work",
          ({ signal }: { signal: AbortSignal }) =>
            new Promise(() => {
              signal.addEventListener("abort", () => (aborted = Date.now() - started));
            }),
          { timeout: "1s" },
        ),
      ),
    ]);
    try {
      const [status, body] = await service.get("/health/ready");
      expect([status, body.checks["slow.work"].error]).toEqual([503, "Timed out after 1s"]);
      expect(aborted).toBeGreaterThanOrEqual(950);
    } finally {
      await service.stop();
    }
  });
});

describe("starting and draining", () => {
  test("ready answers starting until every onStart ran, while live answers at once", async () => {
    const service = await prepare({ health: {} }, [
      defineFeature({
        key: "slowstart",
        setup(ctx) {
          ctx.app.onStart(() => Bun.sleep(2000));
        },
      }),
    ]);
    try {
      const starting = service.start();
      await Bun.sleep(50);
      expect(await service.get("/health/ready")).toEqual([503, { status: "starting" }]);
      expect(await service.get("/health/live")).toEqual([200, { status: "ok" }]);
      await starting;
      expect((await service.get("/health/ready"))[0]).toBe(200);
    } finally {
      await service.stop();
    }
  });

  test("after a shutdown signal ready answers draining while other routes serve for drainDelay; 0s closes at once", async () => {
    const service = await serve({ health: { drainDelay: "2s" } });
    const started = Date.now();
    notifyShutdownSignal();
    const shutdown = service.lifecycle.shutdown();
    expect(await service.get("/health/ready")).toEqual([503, { status: "draining" }]);
    await Bun.sleep(1500);
    expect((await service.get("/users"))[0]).toBe(200);
    await shutdown;
    expect(Date.now() - started).toBeGreaterThanOrEqual(1950);
    await service.stop();

    const quick = await serve({ health: {} });
    const at = Date.now();
    notifyShutdownSignal();
    await quick.lifecycle.shutdown();
    expect(Date.now() - at).toBeLessThan(500);
    await quick.stop();
  });

  test("a drainDelay longer than lifecycle.stopTimeout is a configuration error", () => {
    expect(() => resolveConfig({ database: memoryAdapter(), health: { drainDelay: "30s" } } as ServiceConfig, {})).toThrow("health.drainDelay (30s) must be shorter than lifecycle.stopTimeout (10s)");
    expect(() => resolveConfig({ database: memoryAdapter(), health: { drainDelay: "30s" }, lifecycle: { stopTimeout: "1m" } } as ServiceConfig, {})).not.toThrow();
  });
});
