import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import type { DatabaseAdapter, StoredRecord } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entityModel, field } from "./entity-model.ts";
import pruneJob from "./features/history/jobs/prune.ts";
import { historyModel, historyModels } from "./features/history/model.ts";
import { pruneHistory, pruneVersions } from "./features/history/prune.ts";
import { pruneStores } from "./features/history/commands.ts";
import { jobRunEntity } from "./jobs/job-run.ts";
import { createJobRunner } from "./jobs/scheduler.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import type { EntityModel } from "./model.ts";
import type { Repositories } from "./hooks.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);
const user = { ...entityModel("User", { name: field({ type: "string" }) }), tags: { history: { on: true, options: {} } } } as EntityModel;
const model = historyModel(user);

/** Stores one version of a record, `ageDays` old. */
async function version(adapter: DatabaseAdapter, entityId: string, number: number, operation: string, ageDays: number, extra: Record<string, unknown> = {}) {
  const at = new Date(NOW - ageDays * DAY);
  await adapter.insert(model, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, entityId, version: number, operation, actor: "system", at, record: {}, changed: [], ...extra } as StoredRecord);
}

const remaining = async (adapter: DatabaseAdapter) =>
  (await adapter.findMany(model, { where: [], sort: [{ field: "entityId", direction: "asc" }, { field: "version", direction: "asc" }], limit: 100_000, offset: 0 })).data.map(
    (row) => `${row.entityId}:${row.version}`,
  );

async function database() {
  const adapter = memoryAdapter();
  await adapter.connect([model]);
  return adapter;
}

describe("the pruning rule", () => {
  test("old versions go, recent ones stay, and the current version of a live record is always kept", async () => {
    const adapter = await database();
    await version(adapter, "a", 1, "create", 40);
    await version(adapter, "a", 2, "update", 40);
    await version(adapter, "a", 3, "update", 20);
    await version(adapter, "b", 1, "create", 40);
    await version(adapter, "c", 1, "create", 45);
    await version(adapter, "c", 2, "delete", 40);
    await version(adapter, "d", 1, "create", 3650);
    const deleted = await pruneVersions(adapter, model, { before: new Date(NOW - 30 * DAY) });
    expect(deleted).toBe(4);
    expect(await remaining(adapter)).toEqual(["a:3", "b:1", "d:1"]);
  });

  test("without a retention nothing is deleted, and a dry run only counts", async () => {
    const adapter = await database();
    await version(adapter, "a", 1, "create", 3650);
    await version(adapter, "a", 2, "update", 3650);
    const targets = [{ entity: user, retention: undefined }];
    const stores = pruneStores(adapter, [user, { ...model, feature: "history" }], { entities: "tagged" });
    expect(await pruneHistory({ ...stores, targets, now: NOW })).toEqual({});
    expect(await pruneHistory({ ...stores, targets: [{ ...targets[0]!, retention: "30d" }], now: NOW, dryRun: true })).toEqual({ User: 1 });
    expect(await remaining(adapter)).toEqual(["a:1", "a:2"]);
  });
});

describe("batches", () => {
  test("2500 versions are pruned in three batches, and an aborted signal stops between batches", async () => {
    const adapter = await database();
    for (let index = 0; index < 2500; index++) await version(adapter, `r${index}`, 1, "delete", 40);
    const batches: number[] = [];
    expect(await pruneVersions(adapter, model, { before: new Date(NOW - DAY), onBatch: (size) => batches.push(size) })).toBe(2500);
    expect(batches).toEqual([1000, 1000, 500]);
    for (let index = 0; index < 2500; index++) await version(adapter, `s${index}`, 1, "delete", 40);
    const controller = new AbortController();
    const deleted = await pruneVersions(adapter, model, { before: new Date(NOW - DAY), signal: controller.signal, onBatch: () => controller.abort() });
    expect(deleted).toBe(1000);
    expect(await remaining(adapter)).toHaveLength(1500);
  });

  test("two instances pruning at once delete each version once", async () => {
    const adapter = await database();
    for (let index = 0; index < 2500; index++) await version(adapter, `r${index}`, 1, "delete", 40);
    const [a, b] = await Promise.all([pruneVersions(adapter, model, { before: new Date(NOW - DAY) }), pruneVersions(adapter, model, { before: new Date(NOW - DAY) })]);
    expect(a + b).toBe(2500);
    expect(await remaining(adapter)).toEqual([]);
  });
});

describe("the history/prune job", () => {
  const entries: LogEntry[] = [];
  const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };
  const stops: (() => unknown)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    entries.length = 0;
  });

  async function service(history: Record<string, unknown>) {
    const adapter = memoryAdapter();
    const models = [user, ...historyModels([user], "tagged"), jobRunEntity()];
    const resolved = resolveConfig({ database: adapter, logger, events: {}, history } as ServiceConfig, {});
    const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
    await lifecycle.setup();
    await adapter.connect(models);
    await lifecycle.start({} as never);
    stops.push(async () => {
      await lifecycle.shutdown();
      await lifecycle.stop();
    });
    const runner = createJobRunner({
      jobs: new Map([["history/prune", pruneJob]]),
      database: adapter,
      model: jobRunEntity(),
      repos: {} as Repositories,
      files: {} as never,
      config: resolved.jobs,
      production: false,
      logger,
    });
    return { adapter, runner };
  }

  test("runs daily, records the per-entity counts as its result and logs history.pruned", async () => {
    expect(pruneJob.schedule).toBe("@daily");
    const { adapter, runner } = await service({ retention: "30d" });
    const at = new Date(Date.now() - 40 * DAY);
    for (const number of [1, 2]) await adapter.insert(model, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, entityId: "a", version: number, operation: "update", actor: "system", at, record: {}, changed: [] } as StoredRecord);
    const run = await runner.run({ job: "history/prune", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    expect(run).toMatchObject({ status: "success", result: { User: 1 } });
    const pruned = entries.find((entry) => entry.message === "history.pruned") as LogEntry & { entity: string; deleted: number; durationMs: number };
    expect([pruned.entity, pruned.deleted, typeof pruned.durationMs]).toEqual(["User", 1, "number"]);
  });

  test("does nothing without a retention", async () => {
    const { runner } = await service({});
    expect(await runner.run({ job: "history/prune", trigger: "manual", scheduledAt: new Date(), attempt: 1 })).toMatchObject({ status: "success", result: {} });
    expect(entries.some((entry) => entry.message === "history.pruned")).toBe(false);
  });
});
