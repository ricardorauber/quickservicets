import { describe, expect, test } from "bun:test";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { encodeComment, encodeMessage, lastEventIdOf, openStream, streamRunner } from "./features/realtime/index.ts";
import type { HeartbeatTimer } from "./features/realtime/stream.ts";
import type { Repositories, ServiceRequest } from "./hooks.ts";
import { defineSse, setSseRunner } from "./http/sse.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";

const decoder = new TextDecoder();

/** Reads a body until `done(text)` holds or it ends, then returns what it read. */
async function readUntil(body: ReadableStream<Uint8Array>, done: (text: string) => boolean): Promise<{ text: string; reader: { cancel(): Promise<void> } }> {
  const reader = body.getReader();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += decoder.decode(value);
  }
  return { text, reader };
}

/** A timer that runs its callbacks only when the test advances it. */
function fakeTimer() {
  const intervals = new Map<number, { fn: () => void; ms: number; next: number }>();
  let now = 0;
  let ids = 0;
  const timer: HeartbeatTimer = {
    setInterval(fn, ms) {
      intervals.set(++ids, { fn, ms, next: now + ms });
      return ids;
    },
    clearInterval: (handle) => void intervals.delete(handle as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...intervals.values()].filter((entry) => entry.next <= until).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      now = due.next;
      due.next += due.ms;
      due.fn();
    }
    now = until;
  };
  return { timer, advance, active: () => intervals.size };
}

describe("messages", () => {
  test("strings as they are, other values as JSON, one data line per line, with event, id and retry", () => {
    expect(encodeMessage("hello")).toBe("data: hello\n\n");
    expect(encodeMessage({ now: 1 })).toBe('data: {"now":1}\n\n');
    expect(encodeMessage("a\nb", { event: "note", id: "7" })).toBe("event: note\nid: 7\ndata: a\ndata: b\n\n");
    expect(encodeMessage("x", { retry: 3000 })).toBe("retry: 3000\ndata: x\n\n");
    expect(() => encodeMessage("x", { id: "1\n2" })).toThrow("must not contain a line break");
    expect(() => encodeMessage("x", { event: "a\rb" })).toThrow("must not contain a line break");
    expect(encodeComment("one\ntwo")).toBe(": one\n: two\n\n");
  });

  test("a stream queues its messages and ignores writes after close", async () => {
    const { stream, body, messages } = openStream({ heartbeatMs: 60_000 });
    stream.send("a\nb", { event: "note", id: "7" });
    stream.comment("hi");
    stream.close();
    stream.send("late");
    stream.comment("late");
    const { text } = await readUntil(body, () => false);
    expect(text).toBe("event: note\nid: 7\ndata: a\ndata: b\n\n: hi\n\n");
    expect(messages()).toBe(1);
    expect(() => stream.send("x", { id: "1\n2" })).not.toThrow();
  });
});

describe("heartbeats, failures and disconnects", () => {
  test("an idle stream pings every heartbeat until it closes", async () => {
    const clock = fakeTimer();
    const { stream, body } = openStream({ heartbeatMs: 15_000, timer: clock.timer });
    clock.advance(14_999);
    clock.advance(1);
    clock.advance(30_000);
    stream.close();
    expect(clock.active()).toBe(0);
    const { text } = await readUntil(body, () => false);
    expect(text).toBe(": ping\n\n".repeat(3));
  });

  test("a disconnect aborts the signal and resolves closed; a rejecting handler closes the stream and is logged", async () => {
    const logged: Record<string, unknown>[] = [];
    const runner = streamRunner({ heartbeatMs: 60_000, maxStreams: 10, log: (entry) => void logged.push(entry) });
    let seen: { signal: AbortSignal; closed: Promise<void> } | undefined;
    const req = { id: "req-1" } as ServiceRequest;
    const response = await runner.run(defineSse((stream) => void (seen = stream, stream.send("hi"))), {} as Repositories, req, {} as never);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const { text, reader } = await readUntil(response.body!, (read) => read.includes("hi"));
    expect(text).toBe("data: hi\n\n");
    expect(runner.count()).toBe(1);
    await reader.cancel();
    await seen!.closed;
    expect(seen!.signal.aborted).toBe(true);
    expect(runner.count()).toBe(0);
    const failing = await runner.run(defineSse(async () => Promise.reject(new Error("boom"))), {} as Repositories, req, {} as never);
    await readUntil(failing.body!, () => false);
    expect(logged).toMatchObject([{ message: "sse.handler.failed", requestId: "req-1", error: { message: "boom" } }]);
    expect(runner.count()).toBe(0);
  });

  test("a resolved handler leaves the stream open until it is closed", async () => {
    const runner = streamRunner({ heartbeatMs: 60_000, maxStreams: 10, log: () => undefined });
    await runner.run(defineSse(() => undefined), {} as Repositories, { id: "r" } as ServiceRequest, {} as never);
    await Bun.sleep(5);
    expect(runner.count()).toBe(1);
    runner.closeAll();
    expect(runner.count()).toBe(0);
  });
});

describe("Last-Event-ID", () => {
  test("the header, else the lastEventId query parameter, else undefined", () => {
    const of = (headers: Record<string, string>, query = "") => lastEventIdOf({ headers: new Headers(headers), query: new URLSearchParams(query) });
    expect(of({ "last-event-id": "42" }, "lastEventId=9")).toBe("42");
    expect(of({}, "lastEventId=9")).toBe("9");
    expect(of({})).toBeUndefined();
  });
});

describe("limits, shutdown and the request log", () => {
  test("streams beyond maxStreams answer 503 with Retry-After: 5, and closing all frees them", async () => {
    const runner = streamRunner({ heartbeatMs: 60_000, maxStreams: 2, log: () => undefined });
    const open = defineSse(() => undefined);
    for (let index = 0; index < 2; index++) await runner.run(open, {} as Repositories, { id: "r" } as ServiceRequest, {} as never);
    type Refusal = { status: number; message: string; headers: Record<string, string> };
    const refused = (await runner.run(open, {} as Repositories, { id: "r" } as ServiceRequest, {} as never).catch((error: unknown) => error)) as Refusal;
    expect([refused.status, refused.message, refused.headers]).toEqual([503, "Too many open streams", { "retry-after": "5" }]);
    runner.closeAll();
    expect(runner.count()).toBe(0);
  });

  test("the request log is written when the stream closes, with its duration and messages", async () => {
    const entries: LogEntry[] = [];
    const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };
    const runner = streamRunner({ heartbeatMs: 60_000, maxStreams: 10, log: () => undefined });
    setSseRunner(runner.run);
    try {
      const config = resolveConfig({ database: memoryAdapter(), logger } as ServiceConfig, {});
      const app = createApp({
        models: [],
        crudRoutes: [],
        endpoints: [{ method: "GET", path: "/clock", hooks: [], kind: "sse", handler: defineSse((stream) => (stream.send(1), stream.send(2))) }],
        hooks: new Map(),
        config,
      });
      const response = await app.server.fetch(new Request("http://localhost/clock"));
      const { reader } = await readUntil(response.body!, (text) => text.includes("data: 2"));
      expect(entries.some((entry) => entry.route === "/clock")).toBe(false);
      await reader.cancel();
      await Bun.sleep(1);
      const logged = entries.find((entry) => entry.route === "/clock") as LogEntry & { messages: number; durationMs: number; status: number };
      expect([logged.status, logged.messages, typeof logged.durationMs]).toEqual([200, 2, "number"]);
    } finally {
      setSseRunner(undefined);
    }
  });

  test("without a runner, as with sse disabled at startup, the route answers 404; the heartbeat warning compares with the idle timeout", async () => {
    const entries: LogEntry[] = [];
    const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };
    const start = async (config: Record<string, unknown>, env: Record<string, string> = {}) => {
      const resolved = resolveConfig({ database: memoryAdapter(), logger, ...config } as ServiceConfig, env);
      const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
      await lifecycle.setup();
      const app = createApp({ models: [], crudRoutes: [], endpoints: [{ method: "GET", path: "/clock", hooks: [], kind: "sse", handler: defineSse(() => undefined) }], hooks: new Map(), config: resolved });
      return { app, stop: () => lifecycle.stop() };
    };
    const off = await start({ realtime: {} }, { QS_REALTIME_SSE_ENABLED: "false" });
    try {
      const response = await off.app.server.fetch(new Request("http://localhost/clock"));
      expect([response.status, ((await response.json()) as { error: { message: string } }).error.message]).toEqual([404, "Route not found"]);
    } finally {
      await off.stop();
    }
    const quiet = await start({ realtime: {} });
    await quiet.stop();
    expect(entries.some((entry) => String(entry.message).startsWith("realtime.sse.heartbeat"))).toBe(false);
    const slow = await start({ realtime: { sse: { heartbeat: "45s" } } });
    await slow.stop();
    expect(entries.map((entry) => entry.message)).toContain("realtime.sse.heartbeat (45s) should be shorter than security.timeouts.idle (30s), or idle streams will be closed");
  });
});
