import { afterEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { registerProjectFeatures } from "./features.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { EntityModel } from "./model.ts";
import { describeOptions } from "./options.ts";
import { isQueueDefinition, queue, queueMessageEntity, queues, queuesFeature } from "./index.ts";

afterEach(() => registerProjectFeatures([]));

const resolve = (config: Record<string, unknown> = {}, env: Record<string, string> = {}) => resolveConfig({ database: memoryAdapter(), ...config } as ServiceConfig, env);

describe("options", () => {
  test("queues is off by default and its options have the documented defaults and descriptions", () => {
    expect(resolve().features.map((feature) => feature.key)).not.toContain("queues");
    for (const value of [{}, true]) {
      const feature = resolve({ queues: value }).features.find((candidate) => candidate.key === "queues")!;
      expect(feature.native).toBe(true);
      expect(feature.options).toEqual({
        enabled: true,
        consume: true,
        concurrency: 1,
        pollInterval: "1s",
        timeout: "5m",
        retries: 3,
        retryDelay: "10s",
        maxRetryDelay: "1h",
        retention: { completed: "7d", dead: "30d" },
        overrides: {},
        publish: { queue: "events", events: ["created", "updated", "deleted"] },
      });
    }
    const described = describeOptions(queuesFeature.schema, "queues");
    for (const option of described) expect(option.description).not.toBe("");
    expect(described.map((option) => option.path)).toEqual(
      expect.arrayContaining(["queues.concurrency", "queues.pollInterval", "queues.timeout", "queues.retries", "queues.retryDelay", "queues.maxRetryDelay", "queues.retention.completed", "queues.retention.dead", "queues.overrides.<name>.concurrency", "queues.overrides.<name>.retryDelay", "queues.enabled", "queues.consume"]),
    );
    const overrides = resolve({ queues: { overrides: { "send-email": { concurrency: 4, timeout: "1m" } } } }).features.find((candidate) => candidate.key === "queues")!;
    expect(overrides.options.overrides).toEqual({ "send-email": { concurrency: 4, timeout: "1m" } });
    expect(() => resolve({ queues: { concurrency: 0 } })).toThrow("Invalid queues.concurrency");
    expect(() => resolve({ queues: { retries: -1 } })).toThrow("Invalid queues.retries");
  });

  test("queue() returns a definition with its handler and options", () => {
    const definition = queue<{ to: string }>(async ({ payload }) => payload.to, { concurrency: 2, retries: 1 });
    expect(isQueueDefinition(definition)).toBe(true);
    expect(definition.options).toEqual({ concurrency: 2, retries: 1 });
    expect(isQueueDefinition({ handler: () => {} })).toBe(false);
    expect(() => queue(undefined as never)).toThrow("needs a handler function");
  });
});

describe("the QueueMessage model", () => {
  test("a read-only system entity with the message fields and the claim index", () => {
    const model = queueMessageEntity();
    expect(model).toMatchObject({ key: "QueueMessage", name: "queue-messages", repoKey: "queueMessages", tableName: "queue_messages", internal: true, system: true });
    expect(model.fields.map((field) => field.name)).toEqual([
      "queue",
      "payload",
      "status",
      "priority",
      "runAt",
      "attempt",
      "maxAttempts",
      "dedupeKey",
      "dedupeSlot",
      "lockedUntil",
      "worker",
      "lastError",
      "result",
      "enqueuedAt",
      "startedAt",
      "finishedAt",
      "requestId",
    ]);
    expect(model.fields.find((field) => field.name === "status")).toMatchObject({ type: "enum", values: ["waiting", "active", "completed", "dead"] });
    expect(model.fields.find((field) => field.name === "priority")).toMatchObject({ type: "number", default: 0 });
    expect(model.indexes).toEqual([{ fields: ["queue", "status", "priority", "runAt"] }]);
  });

  test("the native contributes the entity only while it is enabled", () => {
    const entities = queuesFeature.entities as (context: { models: EntityModel[]; options: unknown }) => EntityModel[];
    expect(entities({ models: [], options: {} }).map((model) => model.key)).toEqual(["QueueMessage"]);
    expect(resolve().features.some((feature) => feature.key === "queues")).toBe(false);
  });
});

describe("errors", () => {
  const model = queueMessageEntity();
  const start = async (folders: Record<string, unknown>) => {
    // Without consumers, the added messages stay waiting.
    const config = resolve({ queues: { consume: false } });
    const lifecycle = createFeatureLifecycle({
      features: config.features,
      config,
      models: [model],
      featureFolders: { queues: { queues: new Map(Object.entries(folders)) } },
      worker: { index: 0, count: 1, runsScheduledWork: true },
    });
    await lifecycle.setup();
    await config.database.connect([model]);
    await lifecycle.start({ repos: {} as never, server: {} as never });
    return { config, lifecycle };
  };

  test("an undeclared queue, a payload that is not JSON and add without the native each throw their message", async () => {
    await expect(queues.add("send-email" as never, { to: "a@b.c" } as never)).rejects.toThrow("queues is not enabled; add queues: {} to quickservice.config.ts");
    const { config, lifecycle } = await start({ "send-email": queue(() => {}) });
    try {
      await expect(queues.add("send-mail" as never, {} as never)).rejects.toThrow("Unknown queue send-mail");
      await expect(queues.add("send-email" as never, { amount: 10n } as never)).rejects.toThrow("Queue payload for send-email is not JSON-serializable");
      const added = await queues.add("send-email" as never, { to: "a@b.c" } as never);
      expect(added).toEqual({ id: expect.any(String), deduplicated: false });
      expect(await config.database.findById(model, added.id)).toMatchObject({ queue: "send-email", status: "waiting", attempt: 0, maxAttempts: 4, priority: 0 });
    } finally {
      await lifecycle.stop();
      await config.database.disconnect();
    }
    await expect(queues.add("send-email" as never, {} as never)).rejects.toThrow("queues is not enabled");
  });
});
