import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";

const registered: string[] = [];
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
});

/** The order-300 middlewares of the flags native after a service's setup. */
async function preparing(config: Record<string, unknown>) {
  const resolved = resolveConfig({ database: memoryAdapter(), ...config } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  const found = lifecycle.middleware.filter((entry) => entry.owner === "flags" && (entry.middleware as { order?: number }).order === 300);
  await lifecycle.stop();
  return found;
}

describe("the preparing middleware", () => {
  test("the config source alone registers none; a provider with prepare, or a feature that may set one, registers it", async () => {
    expect(await preparing({ flags: {} })).toHaveLength(0);
    expect(await preparing({ flags: { provider: { isOn: () => false, all: () => ({}) } } })).toHaveLength(0);
    expect(await preparing({ flags: { provider: { isOn: () => false, all: () => ({}), prepare: async () => ({}) } } })).toHaveLength(1);
    registerNative(defineFeature({ key: "remote-flags-test", docs: { summary: "Test provider." }, requires: ["flags"], setup(ctx) { ctx.feature("flags").setProvider({ isOn: () => false, all: () => ({}), prepare: async () => ({}) }); } }));
    registered.push("remote-flags-test");
    expect(await preparing({ flags: {}, "remote-flags-test": {} })).toHaveLength(1);
  });

  test("prepareTimeout defaults to 250ms and QS_FLAGS_PREPARE_TIMEOUT overrides it", () => {
    const options = (env: Record<string, string>) => resolveConfig({ database: memoryAdapter(), flags: {} } as ServiceConfig, env).features.find((feature) => feature.key === "flags")!.options;
    expect(options({})).toMatchObject({ prepareTimeout: "250ms" });
    expect(options({ QS_FLAGS_PREPARE_TIMEOUT: "1s" })).toMatchObject({ prepareTimeout: "1s" });
  });
});
