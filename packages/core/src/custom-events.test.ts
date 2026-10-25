import { afterEach, describe, expect, spyOn, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import type { AnyEvent, CustomEvent, EventFor, WriteEvent } from "./event-types.ts";
import { events } from "./features/events/index.ts";
import * as patterns from "./features/events/patterns.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import { createRepositories, type Repository } from "./repository.ts";
import { entity, field } from "./testing/entities.ts";
import { configureTransactions, transaction } from "./transactions.ts";

declare module "./event-types.ts" {
  interface EventMap {
    "invoice.paid": { invoiceId: string };
  }
}

const user = entity("User", [field({ name: "name", type: "string" })]);
const post = entity("Post", [field({ name: "title", type: "string" })]);
const models = [user, post];
const silent = { info() {}, warn() {}, error() {} };

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function start() {
  const config = resolveConfig({ database: memoryAdapter(), logger: silent, events: {} } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: config.features, config, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await lifecycle.start({} as never);
  stops.push(async () => {
    await lifecycle.shutdown();
    await lifecycle.stop();
  });
  const adapter = memoryAdapter();
  await adapter.connect(models);
  configureTransactions(adapter, silent);
  return createRepositories(models, adapter) as Record<string, Repository>;
}

const failure = async (work: () => unknown): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("emit", () => {
  test("inside a transaction, after-commit listeners get the event after the commit and never after a rollback", async () => {
    await start();
    const seen: string[] = [];
    const inside: string[] = [];
    events.on("invoice.paid", (event) => void seen.push(event.payload.invoiceId));
    events.on("invoice.paid", (event) => void inside.push(event.payload.invoiceId), { phase: "inTransaction" });
    await failure(() =>
      transaction(async () => {
        await events.emit("invoice.paid", { invoiceId: "lost" });
        throw new Error("x");
      }),
    );
    await transaction(async () => {
      await events.emit("invoice.paid", { invoiceId: "i1" });
      expect(inside).toEqual(["lost", "i1"]);
      expect(seen).toEqual([]);
    });
    await events.idle();
    expect(seen).toEqual(["i1"]);
  });

  test("outside a transaction the event is delivered at once and emit returns its UUIDv7", async () => {
    await start();
    const seen: CustomEvent<{ invoiceId: string }>[] = [];
    events.on("invoice.*", (event) => void seen.push(event as CustomEvent<{ invoiceId: string }>));
    const id = await events.emit("invoice.paid", { invoiceId: "i2" });
    await events.idle();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(seen).toEqual([expect.objectContaining({ id, type: "invoice.paid", payload: { invoiceId: "i2" }, actor: {} })]);
  });
});

describe("types", () => {
  test("custom types need two lowercase segments and no write ending", async () => {
    await start();
    for (const type of ["paid", "invoice.created", "Invoice.paid", "invoice.written", "invoice..paid"]) {
      expect((await failure(() => events.emit(type, {}))).message).toStartWith(`Invalid event type ${type}: `);
    }
    expect(typeof (await events.emit("invoice.paid-late", {}))).toBe("string");
  });

  test("EventMap types emit payloads and listener events", () => {
    // Type-level checks: compiled by tsc, never called.
    const typed = () => {
      // @ts-expect-error the payload of invoice.paid has invoiceId
      void events.emit("invoice.paid", { nope: 1 });
      void events.emit("order.shipped", { anything: true });
      events.on("invoice.paid", (event) => void event.payload.invoiceId.toUpperCase());
      const any: EventFor<"*"> = {} as AnyEvent;
      const write: WriteEvent = {} as WriteEvent<{ id: string; createdAt: Date; updatedAt: Date }, "created">;
      return [any, write];
    };
    expect(typed).toBeFunction();
  });
});

describe("patterns", () => {
  test("segments, wildcards, the written alias and invalid patterns", async () => {
    const repos = await start();
    const seen: Record<string, string[]> = { user: [], created: [], written: [], all: [] };
    events.on("user.*", (event) => void seen.user!.push(event.type));
    events.on("*.created", (event) => void seen.created!.push(event.type));
    events.on("user.written", (event) => void seen.written!.push(event.type));
    events.on("*", (event) => void seen.all!.push(event.type));
    const created = await repos.users!.create({ name: "a" });
    await repos.users!.delete(created.id);
    await repos.posts!.create({ title: "t" });
    await events.emit("invoice.paid", { invoiceId: "x" });
    await events.idle();
    expect(seen.user).toEqual(["user.created", "user.deleted"]);
    expect(seen.created).toEqual(["user.created", "post.created"]);
    expect(seen.written).toEqual(["user.created", "user.deleted"]);
    expect(seen.all).toEqual(["user.created", "user.deleted", "post.created", "invoice.paid"]);
    expect(() => events.on("user.**", () => undefined)).toThrow("Invalid event pattern user.**");
    expect(() => events.on("user", () => undefined)).toThrow("Invalid event pattern user");
    expect(patterns.compilePattern("*.*.paid")("a.b.paid")).toBe(true);
    expect(patterns.compilePattern("*.written")("post.updated")).toBe(true);
    expect(patterns.compilePattern("*.written")("invoice.paid")).toBe(false);
  });

  test("dispatch matches patterns once per type, then costs one lookup per event", async () => {
    await start();
    events.on("order.*", () => undefined);
    const matches = spyOn(patterns, "patternMatches");
    try {
      const started = performance.now();
      for (let index = 0; index < 100_000; index++) await events.emit("invoice.paid", { invoiceId: "x" });
      const elapsed = performance.now() - started;
      // One match for the first event of the type (the listener's phase), none afterwards.
      expect(matches.mock.calls.length).toBe(1);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      matches.mockRestore();
    }
  });
});
