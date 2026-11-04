import { describe, expect, test } from "bun:test";
import "./index.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { ConnectionPoolSettings, DatabaseAdapter, PoolEvent } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import type { ConnectEvent, ConnectionErrorEvent } from "./features/connections/index.ts";

const quiet = { info() {}, warn() {}, error() {} };
const postgresUrl = process.env.TEST_POSTGRES_URL;

/** A memory adapter recording the pool settings it receives, and emitting pool events on demand. */
const spyAdapter = () => {
  const calls: ConnectionPoolSettings[] = [];
  const listeners = new Set<(event: PoolEvent) => void>();
  const adapter = Object.assign(memoryAdapter(), {
    configurePool: (settings: ConnectionPoolSettings) => void calls.push(settings),
    onPoolEvent: (listener: (event: PoolEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  }) as DatabaseAdapter;
  return { adapter, calls, listeners, emit: (event: PoolEvent) => listeners.forEach((listener) => listener(event)) };
};

/** Resolves a config and runs the features' setups and starts, then stops them, as a service does. */
async function lifecycleOf(config: Record<string, unknown>, env: Record<string, string> = {}) {
  const resolved = resolveConfig({ logger: quiet, ...config } as ServiceConfig, env);
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: false } });
  await lifecycle.setup();
  await lifecycle.start({ repos: {} as never, server: {} as never });
  return { resolved, lifecycle };
}

const withoutReport = (calls: ConnectionPoolSettings[]) => calls.map(({ onReconnect: _, ...settings }) => settings);

describe("variables and the disabled native", () => {
  test("QS_CONNECTIONS_MAX=3 sets max on every target; QS_CONNECTIONS_ENABLED=false keeps the adapter's pool on lambda", async () => {
    for (const target of ["server", "lambda", "azure-functions", "cloud-run", "binary"]) {
      const spy = spyAdapter();
      const { lifecycle } = await lifecycleOf({ database: spy.adapter, deploy: { target } }, { QS_CONNECTIONS_MAX: "3" });
      await lifecycle.stop();
      expect(withoutReport(spy.calls)[0]?.max).toBe(3);
    }
    const disabled = spyAdapter();
    const { resolved, lifecycle } = await lifecycleOf({ database: disabled.adapter, deploy: { target: "lambda" } }, { QS_CONNECTIONS_ENABLED: "false" });
    await lifecycle.stop();
    expect(disabled.calls).toEqual([]);
    expect(resolved.features.some((feature) => feature.key === "connections")).toBe(false);
  });

  test("every option has its variable", async () => {
    const spy = spyAdapter();
    const env = {
      QS_CONNECTIONS_MODE: "serverless",
      QS_CONNECTIONS_IDLE_TIMEOUT: "10s",
      QS_CONNECTIONS_MAX_LIFETIME: "5m",
      QS_CONNECTIONS_CONNECT_TIMEOUT: "2s",
      QS_CONNECTIONS_LAZY: "false",
      QS_CONNECTIONS_BUDGET: "50",
      QS_CONNECTIONS_INSTANCES: "4",
      QS_CONNECTIONS_PROXY: "pgbouncer",
      QS_CONNECTIONS_DIRECT: "postgres://app:pw@db.internal/app",
    };
    const { resolved, lifecycle } = await lifecycleOf({ database: spy.adapter }, env);
    await lifecycle.stop();
    expect(resolved.features.find((feature) => feature.key === "connections")!.options).toMatchObject({
      mode: "serverless",
      idleTimeout: "10s",
      maxLifetime: "5m",
      connectTimeout: "2s",
      lazy: false,
      budget: 50,
      instances: 4,
      proxy: "pgbouncer",
    });
    expect(withoutReport(spy.calls)).toEqual([{ max: 2, idleTimeout: "10s", maxLifetime: "5m", connectTimeout: "2s", lazy: false }]);
  });
});

describe("pool events and hooks", () => {
  test("onConnect and onConnectionError receive the adapter's events while they listen, and nothing listens without hooks", async () => {
    const connects: ConnectEvent[] = [];
    const errors: ConnectionErrorEvent[] = [];
    const spy = spyAdapter();
    const { lifecycle } = await lifecycleOf({
      database: spy.adapter,
      connections: { onConnect: (event: ConnectEvent) => void connects.push(event), onConnectionError: (event: ConnectionErrorEvent) => void errors.push(event) },
    });
    const lost = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    spy.emit({ type: "connect", durationMs: 12.5 });
    spy.emit({ type: "error", error: lost, retried: true });
    await Bun.sleep(0);
    expect(connects).toEqual([{ adapter: "memory", database: "default", durationMs: 12.5 }]);
    expect(errors).toEqual([{ adapter: "memory", database: "default", error: lost, retried: true }]);
    await lifecycle.stop();
    expect(spy.listeners.size).toBe(0);
    const silent = spyAdapter();
    const quietService = await lifecycleOf({ database: silent.adapter });
    expect(silent.listeners.size).toBe(0);
    await quietService.lifecycle.stop();
  });

  test.skipIf(!postgresUrl)("onConnect receives the open time of a new PostgreSQL connection", async () => {
    const connects: ConnectEvent[] = [];
    const adapter = postgresAdapter({ url: postgresUrl! });
    const { lifecycle } = await lifecycleOf({ database: adapter, connections: { onConnect: (event: ConnectEvent) => void connects.push(event) } });
    await adapter.connect([]);
    try {
      await adapter.ping!();
      for (let attempt = 0; attempt < 50 && connects.length === 0; attempt++) await Bun.sleep(10);
      expect(connects[0]).toMatchObject({ adapter: "postgres", database: "default" });
      expect(connects[0]!.durationMs).toBeGreaterThan(0);
    } finally {
      await lifecycle.stop();
      await adapter.disconnect();
    }
  });

  test("the PostgreSQL adapter reports a retried reconnect and a failed connection", async () => {
    const events: PoolEvent[] = [];
    const adapter = postgresAdapter({ url: "postgres://app:pw@127.0.0.1:1/app" });
    const stop = adapter.onPoolEvent!((event) => void events.push(event));
    await adapter.connect([]);
    try {
      await expect(adapter.ping!()).rejects.toBeDefined();
      expect(events.some((event) => event.type === "error" && !event.retried)).toBe(true);
    } finally {
      stop();
      await adapter.disconnect();
    }
  });
});
