import { describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { databaseStore, idempotencyKeyEntity, LOCK_MS } from "./features/idempotency/store.ts";
import { fingerprintOf, scopeOf } from "./features/idempotency/index.ts";
import type { LogEntry } from "./logger.ts";
import type { ServiceRequest } from "./hooks.ts";
import "./index.ts";

const model = idempotencyKeyEntity();
const HOUR = 3_600_000;

async function setUp() {
  const adapter = memoryAdapter();
  await adapter.connect([model]);
  const clock = { now: Date.parse("2026-11-02T10:00:00Z") };
  const logs: LogEntry[] = [];
  const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
  return { store: databaseStore(adapter, model, logger, () => clock.now), clock, logs, adapter };
}

const request = (method: string, url: string, body: string, route = "/orders") => ({ method, route, raw: new Request(url, { method, body }) }) as unknown as ServiceRequest;

describe("scope and fingerprint", () => {
  test("the fingerprint covers the method, path, sorted query and body; the scope the key, method, route and user", async () => {
    const a = await fingerprintOf(request("POST", "http://x/orders?b=2&a=1", '{"n":1}'));
    expect(await fingerprintOf(request("POST", "http://x/orders?a=1&b=2", '{"n":1}'))).toBe(a);
    expect(await fingerprintOf(request("POST", "http://x/orders?a=1&b=2", '{"n":2}'))).not.toBe(a);
    expect(await fingerprintOf(request("PUT", "http://x/orders?a=1&b=2", '{"n":1}'))).not.toBe(a);
    expect(await fingerprintOf(request("POST", "http://x/other?a=1&b=2", '{"n":1}'))).not.toBe(a);
    const req = request("POST", "http://x/orders", "");
    expect(scopeOf("k1", req, "ana")).toBe(scopeOf("k1", req, "ana"));
    expect(scopeOf("k1", req, "ana")).not.toBe(scopeOf("k1", req, "bob"));
    expect(scopeOf("k1", req, "ana")).not.toBe(scopeOf("k2", req, "ana"));
    expect(scopeOf("k1", req, "ana")).not.toBe(scopeOf("k1", request("POST", "http://x/carts", "", "/carts"), "ana"));
  });
});

describe("the store", () => {
  test("a new scope runs, a done one replays, another fingerprint is reused, a running one is in use until its lock passes", async () => {
    const { store, clock } = await setUp();
    const input = { scope: "s1", fingerprint: "f1", ttlMs: 24 * HOUR };
    const first = await store.begin(input);
    expect(first.kind).toBe("new");
    expect((await store.begin(input)).kind).toBe("inUse");
    expect((await store.begin({ ...input, fingerprint: "f2" })).kind).toBe("reused");
    // The process running it crashed: once the lock passed, another request takes it over.
    clock.now += LOCK_MS + 1000;
    const taken = await store.begin(input);
    expect(taken.kind).toBe("new");
    expect(taken.record.id).toBe(first.record.id);
    await store.complete(taken.record, { status: 201, headers: { "content-type": "application/json" }, body: "{}" }, 24 * HOUR);
    expect((await store.begin(input)).kind).toBe("replay");
  });

  test("a released record lets the next request run; an expired one is not replayed and the cleanup removes it", async () => {
    const { store, clock, logs, adapter } = await setUp();
    const input = { scope: "s1", fingerprint: "f1", ttlMs: 24 * HOUR };
    const first = await store.begin(input);
    await store.release(first.record);
    const second = await store.begin(input);
    expect(second.kind).toBe("new");
    await store.complete(second.record, { status: 200, headers: {}, body: "{}" }, 24 * HOUR);
    clock.now += 23 * HOUR;
    expect((await store.begin(input)).kind).toBe("replay");
    await store.begin({ scope: "s2", fingerprint: "f", ttlMs: HOUR });
    clock.now += 2 * HOUR;
    expect(await store.cleanup()).toBe(2);
    expect(logs.find((entry) => entry.message === "idempotency.cleanup")).toMatchObject({ count: 2 });
    expect((await adapter.findMany(model, { where: [], sort: [], limit: 10, offset: 0, withTotal: false })).data).toEqual([]);
    expect((await store.begin(input)).kind).toBe("new");
  });

  test("concurrent begins of one scope give one new and in-use others", async () => {
    const { store } = await setUp();
    const results = await Promise.all(Array.from({ length: 10 }, () => store.begin({ scope: "s", fingerprint: "f", ttlMs: HOUR })));
    expect(results.filter((result) => result.kind === "new")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "inUse")).toHaveLength(9);
  });
});
