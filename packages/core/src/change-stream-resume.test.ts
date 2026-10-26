import { describe, expect, test } from "bun:test";
import "./index.ts";
import type { StoredRecord } from "./adapter.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entityModel, field } from "./entity-model.ts";
import { parseChangeQuery } from "./features/realtime/changes.ts";
import { followChanges, MAX_REPLAY } from "./features/realtime/follow.ts";
import { eventIdFloor, outboxSource, ringBufferSource, timeOfEventId, type ChangeSource } from "./features/realtime/source.ts";
import type { OutboxRecord } from "./features/events/outbox.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import type { EntityModel } from "./model.ts";
import type { SseSendOptions, SseStream } from "./http/sse.ts";
import type { WriteEvent } from "./event-types.ts";

const task = { ...entityModel("Task", { title: field({ type: "string" }), status: field({ type: "enum", values: ["open", "done"] }) }), tags: { changes: { on: true, options: {} } } } as EntityModel;
let clock = Date.UTC(2026, 9, 1);
/** A write event of a task, with a fresh id one millisecond after the previous one. */
function created(title: string, status = "open", entity = "Task"): WriteEvent {
  clock += 1;
  const random = (digits: number) => Math.floor(Math.random() * 16 ** digits).toString(16).padStart(digits, "0");
  const id = `${eventIdFloor(clock).slice(0, 14)}7${random(3)}-8${random(3)}-${random(12)}`;
  const after = { id: `r-${title}`, createdAt: new Date(clock), updatedAt: new Date(clock), title, status } as StoredRecord;
  return { id, type: `${entity === "Task" ? "task" : "note"}.created`, entity, operation: "created", recordId: after.id, before: null, after, changed: [], cause: "write", actor: {}, at: new Date(clock) } as WriteEvent;
}

/** A stream that records what is sent. */
function recordingStream() {
  const sent: { data: unknown; options: SseSendOptions }[] = [];
  const abort = new AbortController();
  const stream: SseStream = { send: (data, options = {}) => void sent.push({ data, options }), comment: () => undefined, close: () => abort.abort(), signal: abort.signal, closed: Promise.resolve() };
  return { stream, sent, close: () => abort.abort() };
}

const all = parseChangeQuery(task, new URLSearchParams(""), [task]);
const openOnly = parseChangeQuery(task, new URLSearchParams("where[status][eq]=open"), [task]);
const titles = (sent: { data: unknown }[]) => sent.map((message) => ((message.data as { record?: { title: string } }).record?.title ?? (message.data as { reason: string }).reason));

describe("the ring buffer", () => {
  test("keeps the last events, replays after an id, and tells expired from unknown ids", async () => {
    const ring = ringBufferSource(3);
    const events = ["a", "b", "c", "d", "e"].map((title) => created(title));
    const live: string[] = [];
    const stop = ring.subscribe(["Task"], (event) => void live.push(event.id));
    for (const event of events) ring.push(event);
    stop();
    expect(live).toHaveLength(5);
    expect((await ring.replay(["Task"], events[2]!.id, 10)) as WriteEvent[]).toEqual([events[3]!, events[4]!]);
    expect(await ring.replay(["Task"], events[0]!.id, 10)).toBe("expired");
    expect(await ring.replay(["Task"], created("unseen").id, 10)).toBe("unknown");
    expect(await ringBufferSource(3).replay(["Task"], events[0]!.id, 10)).toBe("unknown");
  });

  test("with several workers and no outbox, startup warns that streams see only their worker's writes", async () => {
    const entries: LogEntry[] = [];
    const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };
    for (const workers of [2, 1]) {
      // Several workers need a database server; it is never connected here.
      const resolved = resolveConfig({ database: postgresAdapter({ url: "postgres://localhost/none" }), logger, server: { workers }, events: {}, realtime: {} } as ServiceConfig, {});
      const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [task], worker: { index: 0, count: workers, runsScheduledWork: true } });
      await lifecycle.setup();
      await lifecycle.stop();
    }
    const warning = "realtime change streams see only the writes of their own worker; enable events: { outbox: true } to share them";
    expect(entries.filter((entry) => entry.message === warning)).toHaveLength(1);
  });
});

describe("replay", () => {
  test("missed events matching the filter, in order, then live events, without duplicates; the first message has retry: 3000", async () => {
    const ring = ringBufferSource(100);
    const e5 = created("e5");
    ring.push(e5);
    const e6 = created("e6", "done");
    const e7 = created("e7");
    ring.push(e6);
    ring.push(e7);
    const { stream, sent, close } = recordingStream();
    const following = followChanges(stream, { entity: task, query: openOnly, source: ring, lastEventId: e5.id });
    const e8 = created("e8");
    ring.push(e8);
    await following;
    ring.push(e7);
    const e9 = created("e9");
    ring.push(e9);
    await Bun.sleep(1);
    expect(titles(sent)).toEqual(["e7", "e8", "e9"]);
    expect(sent.map((message) => message.options.id)).toEqual([e7.id, e8.id, e9.id]);
    expect(sent.map((message) => message.options.retry)).toEqual([3000, undefined, undefined]);
    close();
  });

  test("reset: unknown-id for a text that is not an id, expired once the buffer dropped it, too-many beyond the cap", async () => {
    const ring = ringBufferSource(2);
    const first = created("first");
    ring.push(first);
    for (const title of ["1", "2", "3", "4", "5"]) ring.push(created(title));
    for (const [lastEventId, reason] of [["nope", "unknown-id"], [first.id, "expired"]] as const) {
      const { stream, sent, close } = recordingStream();
      await followChanges(stream, { entity: task, query: all, source: ring, lastEventId });
      expect(sent).toEqual([{ data: { reason }, options: { event: "reset", retry: 3000 } }]);
      close();
    }
    const many: ChangeSource = { subscribe: () => () => undefined, replay: async (_entities, _id, limit) => Array.from({ length: Math.min(limit, MAX_REPLAY + 1) }, () => created("x")) };
    const { stream, sent } = recordingStream();
    await followChanges(stream, { entity: task, query: all, source: many, lastEventId: first.id });
    expect(sent).toEqual([{ data: { reason: "too-many" }, options: { event: "reset", retry: 3000 } }]);
  });
});

describe("the outbox source", () => {
  const record = (event: WriteEvent): OutboxRecord => ({ id: event.id, type: event.type, event, at: event.at });

  test("delivers each committed event once, a late commit behind the cursor included, and only events of its entities", async () => {
    const log: OutboxRecord[] = [];
    const read = async ({ after = "", limit = 100 }: { after?: string; limit?: number } = {}) => log.filter((entry) => entry.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
    const source = outboxSource({ pollMs: 5, retentionMs: 86_400_000, onPollFailed: () => undefined, read, now: () => clock });
    const seen: string[] = [];
    const stop = source.subscribe(["Task"], (event) => void seen.push((event.after as unknown as { title: string }).title));
    const early = created("late commit");
    const a = created("a");
    log.push(record(a), record(created("note", "open", "Note")));
    await Bun.sleep(20);
    log.push(record(early));
    await Bun.sleep(20);
    stop();
    expect(seen).toEqual(["a", "late commit"]);
  });

  test("replays after a logged id; an id older than the retention is expired, one the log never had unknown", async () => {
    const events = ["a", "b", "c"].map((title) => created(title));
    const log = events.map((event) => record(event));
    const read = async ({ after = "", limit = 100 }: { after?: string; limit?: number } = {}) => log.filter((entry) => entry.id > after).slice(0, limit);
    const source = outboxSource({ pollMs: 1000, retentionMs: 60_000, onPollFailed: () => undefined, read, now: () => clock });
    expect(((await source.replay(["Task"], events[0]!.id, 10)) as WriteEvent[]).map((event) => event.id)).toEqual([events[1]!.id, events[2]!.id]);
    expect(await source.replay(["Task"], created("unlogged").id, 10)).toBe("unknown");
    expect(await source.replay(["Task"], eventIdFloor(clock - 120_000), 10)).toBe("expired");
    expect(timeOfEventId(events[0]!.id)).toBeLessThan(clock);
  });

  test("polls only while subscribed; a failed poll is reported and the next one delivers", async () => {
    let fail = true;
    const failures: unknown[] = [];
    const a = created("a");
    const read = async () => {
      if (fail) {
        fail = false;
        throw new Error("database down");
      }
      return [record(a)];
    };
    const source = outboxSource({ pollMs: 5, retentionMs: 86_400_000, onPollFailed: (error) => void failures.push(error), read, now: () => clock - 10 });
    const seen: string[] = [];
    const stop = source.subscribe(["Task"], (event) => void seen.push(event.id));
    await Bun.sleep(40);
    stop();
    expect([failures.length, seen]).toEqual([1, [a.id]]);
    expect(source.polling()).toBe(false);
  });
});
