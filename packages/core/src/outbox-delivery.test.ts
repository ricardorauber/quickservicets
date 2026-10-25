import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import type { AnyEvent } from "./event-types.ts";
import { events } from "./features/events/index.ts";
import { startBus, stopBus } from "./features/events/bus.ts";
import { eventCommands } from "./features/events/commands.ts";
import { clearConsumers, createDispatcher, outboxDeliveryEntity, registerConsumer, undeliveredEvents, type DeliverySettings } from "./features/events/delivery.ts";
import { addOutboxPatterns, cleanOutbox, insertOutboxRow, outboxEventEntity, readOutbox, startOutbox, stopOutbox } from "./features/events/outbox.ts";
import type { LogEntry } from "./logger.ts";
import type { CommandContext } from "./commands.ts";

const outboxModel = outboxEventEntity();
const deliveryModel = outboxDeliveryEntity();
const settings: DeliverySettings = { pollInterval: "1s", batch: 100, timeout: "30s", retries: 10, retryDelay: "10s", maxRetryDelay: "1h" };
const entries: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };

afterEach(() => {
  clearConsumers();
  stopOutbox();
  stopBus();
});

async function outbox() {
  const adapter = memoryAdapter();
  await adapter.connect([outboxModel, deliveryModel]);
  startOutbox(adapter, outboxModel, [], deliveryModel);
  startBus({ logger });
  return adapter;
}

const event = (type = "user.created"): AnyEvent => ({ id: Bun.randomUUIDv7(), type, payload: {}, actor: {}, at: new Date() }) as AnyEvent;
const rows = async (adapter: ReturnType<typeof memoryAdapter>) =>
  (await adapter.findMany(deliveryModel, { where: [], sort: [{ field: "id", direction: "asc" }], limit: 1000, offset: 0, withTotal: false })).data;

describe("consumers", () => {
  test("names, duplicates and the outbox are checked; registration adds the patterns to the outbox", async () => {
    expect(() => events.deliver("audit-sink", { pattern: "user.*", handler: () => undefined })).toThrow("events is not enabled");
    startBus({ logger });
    expect(() => events.deliver("audit-sink", { pattern: "user.*", handler: () => undefined })).toThrow("audit-sink needs events: { outbox: true }");
    const adapter = await outbox();
    expect(() => events.deliver("Bad Name", { pattern: "user.*", handler: () => undefined })).toThrow("Invalid outbox consumer Bad Name");
    events.deliver("audit-sink", { pattern: ["user.*", "invoice.paid"], handler: () => undefined });
    expect(() => events.deliver("audit-sink", { pattern: "user.*", handler: () => undefined })).toThrow("Outbox consumer audit-sink is registered twice");
    await events.emit("invoice.paid", { invoiceId: "x" });
    expect((await readOutbox()).map((record) => record.type)).toEqual(["invoice.paid"]);
    expect((await rows(adapter)).map((row) => [row.consumer, row.status, row.attempt])).toEqual([["audit-sink", "pending", 0]]);
  });
});

describe("dispatch", () => {
  test("a delivered row ends delivered with deliveredAt", async () => {
    const adapter = await outbox();
    const received: string[] = [];
    registerConsumer("audit-sink", { pattern: "user.*", handler: (delivered) => void received.push(delivered.type) });
    await insertOutboxRow(event());
    await createDispatcher({ adapter, outboxModel, deliveryModel, settings, logger }).runOnce();
    expect(received).toEqual(["user.created"]);
    const [row] = await rows(adapter);
    expect(row).toMatchObject({ status: "delivered", attempt: 1 });
    expect(row!.deliveredAt).toBeInstanceOf(Date);
    expect(entries).toContainEqual(expect.objectContaining({ message: "events.delivery.delivered", consumer: "audit-sink", type: "user.created", attempt: 1 }));
  });

  test("failures back off exponentially, then succeed; with retries 2 an always failing handler ends failed", async () => {
    const adapter = await outbox();
    let clock = 0;
    const calls: number[] = [];
    registerConsumer("flaky", {
      pattern: "user.*",
      retryDelay: "1s",
      handler: () => {
        calls.push(clock);
        if (calls.length < 3) throw new Error(`failure ${calls.length}`);
      },
    });
    await insertOutboxRow({ ...event(), at: new Date(0) } as AnyEvent);
    const dispatcher = createDispatcher({ adapter, outboxModel, deliveryModel, settings, logger, now: () => clock });
    for (clock = 0; clock <= 4000; clock += 500) await dispatcher.runOnce();
    expect(calls).toEqual([0, 1000, 3000]);
    expect((await rows(adapter))[0]).toMatchObject({ status: "delivered", attempt: 3 });

    registerConsumer("broken", { pattern: "order.*", retries: 2, retryDelay: "1s", handler: () => Promise.reject(new Error("down")) });
    await insertOutboxRow({ ...event("order.created"), at: new Date(0) } as AnyEvent);
    for (clock = 10_000; clock <= 20_000; clock += 500) await dispatcher.runOnce();
    const broken = (await rows(adapter)).find((row) => row.consumer === "broken")!;
    expect(broken).toMatchObject({ status: "failed", attempt: 2, lastError: "down" });
    expect(entries).toContainEqual(expect.objectContaining({ message: "events.delivery.failed", consumer: "broken", attempt: 2 }));
    expect(entries).toContainEqual(expect.objectContaining({ message: "events.delivery.retry", consumer: "flaky", attempt: 1 }));
  });

  test("two instances sharing a database deliver each event once", async () => {
    const adapter = await outbox();
    const received: string[] = [];
    registerConsumer("sink", { pattern: "*", handler: async (delivered) => void received.push(delivered.id) });
    const stored = [event(), event(), event()];
    for (const item of stored) await insertOutboxRow(item);
    const a = createDispatcher({ adapter, outboxModel, deliveryModel, settings, logger });
    const b = createDispatcher({ adapter, outboxModel, deliveryModel, settings, logger });
    await Promise.all([a.runOnce(), b.runOnce(), a.runOnce(), b.runOnce()]);
    expect(received.sort()).toEqual(stored.map((item) => item.id).sort());
  });

  test("a handler exceeding the timeout is aborted and retried", async () => {
    const adapter = await outbox();
    let aborted = false;
    let attempts = 0;
    registerConsumer("slow", {
      pattern: "*",
      handler: (_event, { signal }) =>
        new Promise<void>((resolve) => {
          attempts++;
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    });
    await insertOutboxRow(event());
    await createDispatcher({ adapter, outboxModel, deliveryModel, settings: { ...settings, timeout: "1s" }, logger }).runOnce();
    expect(aborted).toBe(true);
    expect(attempts).toBe(1);
    expect((await rows(adapter))[0]).toMatchObject({ status: "pending", attempt: 1 });
  });

  test("a crash after the handler ran repeats the delivery once the lease expires (at least once)", async () => {
    const adapter = await outbox();
    let clock = 0;
    let calls = 0;
    registerConsumer("sink", { pattern: "*", handler: () => void calls++ });
    await insertOutboxRow({ ...event(), at: new Date(0) } as AnyEvent);
    // The first worker claims the row, runs the handler and dies before storing the outcome.
    const [row] = await rows(adapter);
    await adapter.updateById(deliveryModel, row!.id, { status: "delivering", attempt: 1, lockedUntil: new Date(30_000) });
    calls++;
    const dispatcher = createDispatcher({ adapter, outboxModel, deliveryModel, settings, logger, now: () => clock });
    await dispatcher.runOnce();
    expect(calls).toBe(1);
    clock = 31_000;
    await dispatcher.runOnce();
    expect(calls).toBe(2);
    expect((await rows(adapter))[0]).toMatchObject({ status: "delivered", attempt: 2 });
  });

  test("shutdown stops claiming and waits for the running handler", async () => {
    const adapter = await outbox();
    let finished = false;
    registerConsumer("sink", { pattern: "*", handler: async () => {
      await Bun.sleep(50);
      finished = true;
    } });
    await insertOutboxRow(event());
    const dispatcher = createDispatcher({ adapter, outboxModel, deliveryModel, settings: { ...settings, pollInterval: "10ms" }, logger });
    dispatcher.start();
    await Bun.sleep(20);
    dispatcher.stop();
    await insertOutboxRow(event());
    await dispatcher.drain(1000);
    expect(finished).toBe(true);
    expect((await rows(adapter)).map((row) => row.status)).toEqual(["delivered", "pending"]);
  });
});

describe("retention", () => {
  test("events with undelivered rows stay; delivered rows go with their event", async () => {
    const adapter = await outbox();
    registerConsumer("sink", { pattern: "*", handler: () => undefined });
    const old = (type: string) => ({ ...event(type), at: new Date(0) }) as AnyEvent;
    const failed = old("a.failed");
    const delivered = old("a.done");
    await insertOutboxRow(failed);
    await insertOutboxRow(delivered);
    const all = await rows(adapter);
    await adapter.updateById(deliveryModel, all[0]!.id, { status: "failed" });
    await adapter.updateById(deliveryModel, all[1]!.id, { status: "delivered" });
    const count = await cleanOutbox({
      retentionMs: 1000,
      now: Date.now(),
      keep: (ids) => undeliveredEvents(adapter, deliveryModel, ids),
      removed: async (ids) => {
        for (const row of await rows(adapter)) if (ids.includes(row.event as string)) await adapter.deleteById(deliveryModel, row.id);
      },
    });
    expect(count).toBe(1);
    expect((await readOutbox()).map((record) => record.type)).toEqual(["a.failed"]);
    expect((await rows(adapter)).map((row) => row.status)).toEqual(["failed"]);
  });
});

describe("commands", () => {
  const context = (adapter: ReturnType<typeof memoryAdapter>, args: Record<string, string | undefined>, flags: Record<string, unknown>) => {
    const lines: string[] = [];
    const ctx = {
      args,
      flags,
      cwd: ".",
      config: { database: adapter },
      options: { outbox: { enabled: true } },
      output: { log: (line: string) => void lines.push(line), error: (line: string) => void lines.push(line) },
      connect: async () => ({}),
    } as unknown as CommandContext<never>;
    return { ctx, lines };
  };

  test("events outbox lists counts per consumer, and events retry resets failed deliveries", async () => {
    const adapter = await outbox();
    registerConsumer("audit-sink", { pattern: "*", handler: () => undefined });
    for (let index = 0; index < 3; index++) await insertOutboxRow(event());
    const all = await rows(adapter);
    await adapter.updateById(deliveryModel, all[0]!.id, { status: "failed" });
    await adapter.updateById(deliveryModel, all[1]!.id, { status: "failed" });
    const [outboxCommand, retryCommand] = eventCommands;
    const listed = context(adapter, {}, {});
    await outboxCommand!.run(listed.ctx);
    expect(listed.lines[0]).toStartWith("audit-sink: pending 1, delivering 0, delivered 0, failed 2; oldest pending ");
    const one = context(adapter, { id: all[0]!.id }, { failed: false });
    await retryCommand!.run(one.ctx as never);
    expect(one.lines).toEqual(["Reset 1 delivery to pending"]);
    const byConsumer = context(adapter, {}, { consumer: "audit-sink", failed: true });
    await retryCommand!.run(byConsumer.ctx as never);
    expect(byConsumer.lines).toEqual(["Reset 1 delivery to pending"]);
    expect((await rows(adapter)).map((row) => [row.status, row.attempt])).toEqual([["pending", 0], ["pending", 0], ["pending", 0]]);
    addOutboxPatterns([]);
  });
});
