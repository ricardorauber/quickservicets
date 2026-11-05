import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { fakeClock } from "./jobs/test-support.ts";
import { createFeatureLifecycle, notifyShutdownSignal, onShutdownSignal } from "./lifecycle.ts";
import { resolveConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { firstAddress, ownInstance, registryFeature, setRegistryClock, statusOfReadiness, type RegistryProvider, type ServiceInstance } from "./index.ts";

/** The instance is named after the package of the working directory, without its scope. */
const packageName = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { name: string }).name.replace(/^@[^/]+\//, "");

const started: TestApp[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  registerProjectFeatures([]);
  setRegistryClock();
});

/** A provider recording every call, failing `register` the first `failures` times. */
function recordingProvider(failures = 0) {
  const calls: { call: string; instance: ServiceInstance; status?: string }[] = [];
  let left = failures;
  const provider: RegistryProvider = {
    register(instance) {
      if (left-- > 0) throw new Error("registry down");
      calls.push({ call: "register", instance: { ...instance } });
    },
    heartbeat: (instance, status) => void calls.push({ call: "heartbeat", instance: { ...instance }, status }),
    deregister: (instance) => void calls.push({ call: "deregister", instance: { ...instance } }),
    resolve: () => [],
  };
  return { provider, calls };
}

const providerFeature = (provider: RegistryProvider, key = "testregistry", extra: Partial<Parameters<typeof defineFeature>[0]> = {}) => ({
  folder: key,
  definition: defineFeature({ key, enabledByDefault: true, requires: ["registry"], ...extra, setup: (ctx) => ctx.feature("registry").setProvider(provider) }),
});

const start = async (config: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
  const app = await startTestApp({ config: { registry: {}, ...config }, env });
  started.push(app);
  return app;
};

describe("options and the instance", () => {
  test("the options default to the static provider with 10s heartbeats and a 30s ttl, and the instance id is <name>-<hostname>-<pid>", () => {
    const options = resolveConfig({ database: memoryAdapter(), registry: {} } as never, {}).features.find((feature) => feature.key === "registry")!.options;
    expect(options).toEqual({ enabled: true, metadata: {}, provider: "static", register: true, heartbeat: "10s", ttl: "30s" });
    expect(registryFeature.enabledByDefault).toBe(false);
    const instance = ownInstance({ metadata: { region: "eu" } }, { name: "billing", version: "2.1.0", port: 8080 });
    expect(instance).toEqual({ id: `billing-${hostname()}-${process.pid}`, name: "billing", version: "2.1.0", address: `http://${firstAddress()}:8080`, status: "passing", metadata: { region: "eu" } });
    expect(ownInstance({ name: "api", address: "https://api.internal/", metadata: {}, zone: "a" }, { name: "x", port: 1 })).toMatchObject({ name: "api", address: "https://api.internal", zone: "a" });
    const interfaces = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }], en0: [{ address: "fe80::1", family: "IPv6", internal: false }, { address: "10.0.0.7", family: "IPv4", internal: false }] } as never;
    expect(firstAddress(interfaces)).toBe("10.0.0.7");
    expect(statusOfReadiness("ok")).toBe("passing");
    expect(statusOfReadiness("degraded")).toBe("warning");
    expect(statusOfReadiness("fail")).toBe("critical");
  });
});

describe("registration and heartbeats", () => {
  test("startup registers one instance after the onStart callbacks, and heartbeats report passing, then critical once a check fails", async () => {
    const clock = fakeClock();
    setRegistryClock(clock);
    const { provider, calls } = recordingProvider();
    const order: string[] = [];
    const late = { folder: "late", definition: defineFeature({ key: "late", enabledByDefault: true, after: ["registry"], setup: (ctx) => ctx.app.onStart(() => void order.push(`onStart, ${calls.length} calls`)) }) };
    registerProjectFeatures([providerFeature(provider), late]);
    const state = { down: false };
    await start({ registry: { version: "2.1.0", address: "http://10.0.0.5:8080" }, health: { cache: "0s", checks: { store: () => { if (state.down) throw new Error("database unreachable"); } } } });
    expect(order).toEqual(["onStart, 0 calls"]);
    expect(calls).toEqual([{ call: "register", instance: expect.objectContaining({ name: packageName, version: "2.1.0", address: "http://10.0.0.5:8080", status: "passing" }) }]);
    await clock.advance(10_000);
    expect(calls.at(-1)).toMatchObject({ call: "heartbeat", status: "passing" });
    state.down = true;
    await clock.advance(10_000);
    expect(calls.at(-1)).toMatchObject({ call: "heartbeat", status: "critical" });
    expect(calls.filter((call) => call.call === "heartbeat")).toHaveLength(2);
  });

  test("a worker that does not run scheduled work never registers", async () => {
    const { provider, calls } = recordingProvider();
    registerProjectFeatures([providerFeature(provider)]);
    const config = resolveConfig({ database: memoryAdapter(), registry: {} } as never, {});
    const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [], worker: { index: 1, count: 2, runsScheduledWork: false } });
    await lifecycle.setup();
    await lifecycle.start({ repos: {} as never, server: {} as never });
    await lifecycle.stop();
    expect(calls).toEqual([]);
  });
});

describe("shutdown", () => {
  test("the shutdown signal deregisters the instance before the listeners that start draining", async () => {
    const { provider, calls } = recordingProvider();
    registerProjectFeatures([providerFeature(provider)]);
    const app = await start({ health: {} });
    const order: string[] = [];
    const off = onShutdownSignal(() => void order.push(`draining after ${calls.map((call) => call.call).join(",")}`));
    try {
      notifyShutdownSignal();
      expect(order).toEqual(["draining after register,deregister"]);
      expect(((await (await app.fetch("/health/ready")).json()) as { status: string }).status).toBe("draining");
    } finally {
      off();
    }
    await app.stop();
    expect(calls.filter((call) => call.call === "deregister")).toHaveLength(1);
  });
});

describe("failures", () => {
  test("a provider failing twice on register is retried after 1 and 2 seconds, startup completes, and the registry check fails until then", async () => {
    const clock = fakeClock();
    setRegistryClock(clock);
    const { provider, calls } = recordingProvider(2);
    registerProjectFeatures([providerFeature(provider)]);
    const app = await start({ health: { cache: "0s" } });
    const check = async () => ((await (await app.fetch("/health/ready")).json()) as { checks: Record<string, { status: string }> }).checks.registry?.status;
    expect(app.logs.filter((entry) => entry.message === "registry.register.failed")).toEqual([expect.objectContaining({ provider: "testregistry", reason: "registry down" })]);
    expect(await check()).toBe("fail");
    await clock.advance(1000);
    expect(calls).toEqual([]);
    expect(app.logs.filter((entry) => entry.message === "registry.register.failed")).toHaveLength(2);
    await clock.advance(2000);
    expect(calls.map((call) => call.call)).toEqual(["register"]);
    expect(await check()).toBe("ok");
  });
});

describe("providers", () => {
  test("a feature's provider replaces static, and two features setting one fail naming both", async () => {
    const { provider, calls } = recordingProvider();
    registerProjectFeatures([providerFeature(provider)]);
    await start();
    expect(calls.map((call) => call.call)).toEqual(["register"]);
    await started.pop()!.stop();
    registerProjectFeatures([providerFeature(recordingProvider().provider, "first"), providerFeature(recordingProvider().provider, "second")]);
    await expect(start()).rejects.toThrow("Registry provider set by first and second; keep one");
  });

  test("without the native nothing registers and no timer exists", async () => {
    const clock = fakeClock();
    setRegistryClock(clock);
    const app = await startTestApp({ config: {} });
    started.push(app);
    expect(app.config.features.some((feature) => feature.key === "registry")).toBe(false);
    expect(clock.timers()).toBe(0);
  });
});
