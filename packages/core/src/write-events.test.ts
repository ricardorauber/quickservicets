import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { events, eventsFeature } from "./features/events/index.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import { currentOperation, disableOperationContext, enableOperationContext, operationMiddleware, withJobOperation, withOperation } from "./operation-context.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { recordStatements, resetPostgresTables } from "./testing/postgres.ts";
import { configureTransactions, transaction } from "./transactions.ts";
import { changedFields, observeWrites, type WriteChange } from "./write-observers.ts";
import type { ServiceRequest } from "./hooks.ts";
import type { WriteEvent } from "./event-types.ts";

const user = entity("User", [field({ name: "name", type: "string" }), field({ name: "email", type: "string", optional: true })]);
const orderItem = entity("OrderItem", [field({ name: "sku", type: "string" })]);
const log = entity("Log", [field({ name: "line", type: "string" })], { system: true });
const models = [user, orderItem, log];

type Repos = Record<string, Repository>;
const entries: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function repositories(adapter = memoryAdapter()) {
  await adapter.connect(models);
  configureTransactions(adapter, logger);
  return { adapter, repos: createRepositories(models, adapter) as Repos };
}

/** Starts the events native the way a service does, and stops it after the test. */
async function startEvents(config: Record<string, unknown> = { events: {} }) {
  const resolved = resolveConfig({ database: memoryAdapter(), logger, ...config } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await lifecycle.start({} as never);
  stops.push(async () => {
    await lifecycle.shutdown();
    await lifecycle.stop();
  });
  return lifecycle;
}

const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("write observers", () => {
  test("creates, updates and deletes report their stored records and changed fields", async () => {
    const { repos } = await repositories();
    const changes: WriteChange[] = [];
    stops.push(observeWrites({ needsBefore: true, write: (change) => void changes.push(change) }));
    const created = await repos.users!.create({ name: "A" });
    await repos.users!.update(created.id, { name: "B" });
    await repos.users!.replace(created.id, { name: "C", email: "c@x.co" });
    await repos.users!.delete(created.id);
    expect(changes.map((change) => [change.operation, change.before?.name ?? null, change.after?.name ?? null, change.cause])).toEqual([
      ["created", null, "A", "write"],
      ["updated", "A", "B", "write"],
      ["updated", "B", "C", "write"],
      ["deleted", "C", null, "write"],
    ]);
    expect(changes[1]!.changed).toEqual(["name"]);
    expect(changes[2]!.changed.sort()).toEqual(["email", "name"]);
    expect(changes[0]!.entity).toBe(user);
  });

  test("observers see only the entities they accept, and the unsubscribe function stops them", async () => {
    const { repos } = await repositories();
    const seen: string[] = [];
    const stop = observeWrites({ entities: ["OrderItem"], write: (change) => void seen.push(change.entity.key) });
    await repos.users!.create({ name: "A" });
    await repos.orderitems!.create({ sku: "x" });
    stop();
    await repos.orderitems!.create({ sku: "y" });
    expect(seen).toEqual(["OrderItem"]);
  });

  test("changed compares top-level stored values, updatedAt excluded", () => {
    const at = new Date(1);
    const before = { id: "1", createdAt: at, updatedAt: at, tags: ["a"], name: "A" };
    expect(changedFields(before, { ...before, updatedAt: new Date(2), tags: ["a"], name: "B" })).toEqual(["name"]);
  });
});

describe("transactions and before", () => {
  test("a throwing transactional observer rolls the write back and rejects the call", async () => {
    const { repos } = await repositories();
    const created = await repos.users!.create({ name: "A" });
    stops.push(
      observeWrites({
        transactional: true,
        write: (change) => {
          if (change.operation === "updated") throw new Error("vetoed");
        },
      }),
    );
    expect((await failure(() => repos.users!.update(created.id, { name: "B" }))).message).toBe("vetoed");
    expect((await repos.users!.findById(created.id))!.name).toBe("A");
  });

  test("with an observer needing before, an update reads it inside a transaction with a row lock", async () => {
    if (!process.env.TEST_POSTGRES_URL) return;
    const adapter = postgresAdapter({ url: process.env.TEST_POSTGRES_URL });
    await adapter.connect(models);
    await resetPostgresTables(adapter.client!, models);
    const repos = createRepositories(models, adapter) as Repos;
    const created = await repos.users!.create({ name: "A" });
    const statements = recordStatements(adapter.client!);
    await Bun.sleep(2);
    await repos.users!.update(created.id, { name: "B" });
    expect(statements.statements).toHaveLength(1);
    statements.clear();
    stops.push(observeWrites({ needsBefore: true, write: () => undefined }));
    await repos.users!.update(created.id, { name: "C" });
    expect(statements.statements[0]).toBe("begin");
    expect(statements.statements.some((statement) => /for update/i.test(statement))).toBe(true);
    expect(statements.statements.at(-1)).toBe("commit");
    await adapter.disconnect();
  });
});

describe("operation context", () => {
  test("costs nothing until enabled; requests and jobs then run inside their operation", async () => {
    expect(withOperation({ requestId: "r1" }, () => currentOperation())).toBeUndefined();
    enableOperationContext();
    try {
      expect(withOperation({ requestId: "r1" }, () => currentOperation())).toEqual({ requestId: "r1" });
      expect(withJobOperation({ name: "nightly", runId: "j1" }, () => currentOperation())).toEqual({ job: { name: "nightly", runId: "j1" } });
      const req = { id: "req-1" } as ServiceRequest;
      const seen = await operationMiddleware.run(req, {} as never, async () => currentOperation() as never);
      expect(seen).toEqual({ requestId: "req-1", req });
    } finally {
      disableOperationContext();
    }
  });
});

describe("the events native", () => {
  test("write events have UUIDv7 ids, lower camel types, before and after, and actors from the operation", async () => {
    await startEvents();
    const { repos } = await repositories();
    const received: { type: string; id: string; actor: unknown; requestId?: string; before: unknown; cause: string }[] = [];
    events.on("*", (event) => void received.push(event as never));
    const req = { id: "req-1", user: { id: "u1" }, tenant: { id: "t1" } } as unknown as ServiceRequest;
    const created = await withOperation({ requestId: "req-1", req }, () => repos.users!.create({ name: "A" }));
    await withJobOperation({ name: "nightly", runId: "run-1" }, () => repos.orderitems!.create({ sku: "x" }));
    await repos.logs!.query().all();
    await events.idle();
    expect(received.map((event) => event.type)).toEqual(["user.created", "orderItem.created"]);
    expect(received[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(received[0]).toMatchObject({ actor: { user: "u1", tenant: "t1" }, requestId: "req-1", before: null, cause: "write" });
    expect(received[1]).toMatchObject({ actor: { job: "nightly" } });
    expect(created.name).toBe("A");
  });

  test("system entities emit no events", async () => {
    await startEvents();
    const { adapter } = await repositories();
    const received: string[] = [];
    events.on("*", (event) => void received.push(event.type));
    const { createRepository } = await import("./repository.ts");
    await createRepository(log, adapter, models).create({ line: "x" });
    await events.idle();
    expect(received).toEqual([]);
  });

  test("in-transaction listeners veto the write; after-commit failures are logged and later events still arrive", async () => {
    await startEvents();
    const { repos } = await repositories();
    const stop = events.on(
      "user.created",
      () => {
        throw new Error("no users today");
      },
      { phase: "inTransaction" },
    );
    expect((await failure(() => repos.users!.create({ name: "A" }))).message).toBe("no users today");
    expect(await repos.users!.query().all()).toEqual([]);
    stop();
    entries.length = 0;
    const seen: string[] = [];
    let first = true;
    events.on("user.created", (event) => {
      if (first) {
        first = false;
        throw new Error("listener broke");
      }
      seen.push((event as WriteEvent).recordId);
    });
    await repos.users!.create({ name: "A" });
    const second = await repos.users!.create({ name: "B" });
    await events.idle();
    expect(seen).toEqual([second.id]);
    expect(entries).toContainEqual(expect.objectContaining({ message: "event.listener.failed", type: "user.created", eventId: expect.any(String) }));
  });

  test("after-commit listeners see committed transactions in order and never rolled-back writes", async () => {
    await startEvents();
    const { repos } = await repositories();
    const seen: string[] = [];
    events.on("*", (event) => void seen.push(((event as WriteEvent).after as { name?: string } | null)?.name ?? ""));
    await failure(() =>
      transaction(async () => {
        await repos.users!.create({ name: "rolled back" });
        throw new Error("x");
      }),
    );
    await transaction(async () => {
      await repos.users!.create({ name: "one" });
      await repos.users!.create({ name: "two" });
      expect(seen).toEqual([]);
    });
    await events.idle();
    expect(seen).toEqual(["one", "two"]);
  });

  test("a slow listener does not delay the write, idle waits for it, and unsubscribing stops delivery", async () => {
    await startEvents();
    const { repos } = await repositories();
    let finished = false;
    const stop = events.on("user.created", async () => {
      await Bun.sleep(50);
      finished = true;
    });
    const started = performance.now();
    await repos.users!.create({ name: "A" });
    expect(performance.now() - started).toBeLessThan(40);
    expect(finished).toBe(false);
    await events.idle();
    expect(finished).toBe(true);
    stop();
    finished = false;
    await repos.users!.create({ name: "B" });
    await events.idle();
    expect(finished).toBe(false);
  });

  test("shutdown waits for pending deliveries within the stop timeout, then logs what is left", async () => {
    const lifecycle = await startEvents({ events: {}, lifecycle: { stopTimeout: "1s" } });
    const { repos } = await repositories();
    events.on("user.created", () => Bun.sleep(3000));
    await repos.users!.create({ name: "A" });
    entries.length = 0;
    const started = performance.now();
    await lifecycle.shutdown();
    expect(performance.now() - started).toBeLessThan(1500);
    expect(entries).toContainEqual(expect.objectContaining({ message: "events.shutdown.pending", count: 1 }));
  });

  test("without the native, events refuse to work and no observer is installed", async () => {
    resolveConfig({ database: memoryAdapter(), logger } as ServiceConfig, {});
    expect(() => events.on("*", () => undefined)).toThrow("events is not enabled; add events: {} to quickservicets.config.ts");
    expect(() => eventsFeature.options()).toThrow("events is not enabled");
    const { observersOf } = await import("./write-observers.ts");
    expect(observersOf(user)).toBeNull();
    expect(currentOperation()).toBeUndefined();
  });
});
