import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import type { FlagsApi } from "./features/flags/api.ts";
import { featureFlagEntity } from "./features/flags/store.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import type { EntityModel } from "./model.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { configureTransactions, transaction } from "./transactions.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  registerProjectFeatures([]);
});
/** A project feature that hands out the flags API of each service it runs in. */
const apis: FlagsApi[] = [];
const probe = defineFeature({ key: "probe", requires: ["flags"], setup: (ctx) => void apis.push(ctx.feature("flags")) });
const entries: LogEntry[] = [];
const logger = { info: () => undefined, warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };

/** Starts the flags native on a database the way a service does, returning its feature API and the repositories. */
async function start(adapter: DatabaseAdapter, flags: Record<string, unknown>, models: EntityModel[] = [featureFlagEntity()]) {
  registerProjectFeatures([{ folder: "probe", definition: probe }]);
  const resolved = resolveConfig({ database: adapter, logger, flags, probe: {} } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  const flagsApi = apis.at(-1)!;
  await adapter.connect(models);
  configureTransactions(adapter);
  const repos = createRepositories(models, adapter) as unknown as { featureFlags: Repository };
  await lifecycle.start({ repos } as never);
  stops.push(() => lifecycle.stop());
  const api = { isOn: (name: string, user?: string) => flagsApi.isOn(name, user ? { user: { id: user } } : {}) };
  return { repos, api };
}

describe("the model", () => {
  test("FeatureFlag is an internal, writable entity with the flag fields; the database source without it fails startup", async () => {
    const model = featureFlagEntity();
    expect([model.key, model.name, model.repoKey, model.internal, model.system]).toEqual(["FeatureFlag", "feature-flags", "featureFlags", true, undefined]);
    expect(model.fields.map((field) => field.name)).toEqual(["name", "enabled", "users", "tenants", "percentage", "description"]);
    const resolved = resolveConfig({ database: memoryAdapter(), logger, flags: { source: "database" } } as ServiceConfig, {});
    const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
    await expect(lifecycle.setup()).rejects.toThrow('flags.source is "database" but the FeatureFlag entity is missing; set flags: { source: "database" } in quickservice.config.ts, then run quickservice migration add');
  });
});

describe("the cache", () => {
  test("rows replace config rules of the same name; config rules without a row keep their value", async () => {
    const adapter = memoryAdapter();
    await adapter.connect([featureFlagEntity()]);
    const now = new Date();
    await adapter.insert(featureFlagEntity(), { id: Bun.randomUUIDv7(), createdAt: now, updatedAt: now, name: "checkout-v2", enabled: false });
    const { api } = await start(adapter, { source: "database", rules: { "checkout-v2": true, "dark-mode": true } });
    expect([api.isOn("checkout-v2"), api.isOn("dark-mode")]).toEqual([false, true]);
  });

  test("a local write applies after commit and never after a rollback; another instance sees it at the next refresh; a failed reload keeps the values", async () => {
    const adapter = memoryAdapter();
    const first = await start(adapter, { source: "database", refresh: "1s" });
    const second = await start(adapter, { source: "database", refresh: "1s" });
    await expect(
      transaction(async () => {
        await first.repos.featureFlags.create({ name: "beta", users: ["u1"] });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(first.api.isOn("beta", "u1")).toBe(false);
    await first.repos.featureFlags.create({ name: "beta", users: ["u1"] });
    expect(first.api.isOn("beta", "u1")).toBe(true);
    // Another process writes straight to the shared table: this one sees the row at its next refresh.
    const now = new Date();
    await adapter.insert(featureFlagEntity(), { id: Bun.randomUUIDv7(), createdAt: now, updatedAt: now, name: "gamma", enabled: true, users: ["u1"] });
    expect(second.api.isOn("gamma", "u1")).toBe(false);
    await Bun.sleep(1200);
    expect(second.api.isOn("gamma", "u1")).toBe(true);
    expect(second.api.isOn("beta", "u1")).toBe(true);
    const findMany = adapter.findMany;
    adapter.findMany = () => Promise.reject(new Error("database down"));
    await Bun.sleep(1100);
    adapter.findMany = findMany;
    expect(second.api.isOn("gamma", "u1")).toBe(true);
    expect(entries.some((entry) => entry.message === "flags.refresh.failed")).toBe(true);
    await expect(first.repos.featureFlags.create({ name: "Bad Name" })).rejects.toThrow("Invalid flags.rules.Bad Name");
  }, 10_000);
});
