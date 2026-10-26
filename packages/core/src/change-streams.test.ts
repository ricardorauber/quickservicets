import { describe, expect, test } from "bun:test";
import "./index.ts";
import type { StoredRecord } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { entityModel, field } from "./entity-model.ts";
import { changeEntities, changeHub, changeMessage, parseChangeQuery } from "./features/realtime/changes.ts";
import { matchesConditions } from "./matching.ts";
import type { EntityModel } from "./model.ts";
import type { Condition } from "./query.ts";
import type { WriteEvent } from "./event-types.ts";
import type { HttpError } from "./errors.ts";

const task = entityModel("Task", {
  title: field({ type: "string" }),
  status: field({ type: "enum", values: ["open", "done"] }),
  priority: field({ type: "number", optional: true }),
  dueAt: field({ type: "date", optional: true }),
  secret: field({ type: "string", optional: true, hidden: true }),
});
const tagged = (model: EntityModel, on: boolean): EntityModel => ({ ...model, tags: { changes: { on, options: {} } } });
const at = new Date("2026-01-01T00:00:00Z");
const record = (fields: Record<string, unknown>): StoredRecord => ({ id: "t1", createdAt: at, updatedAt: at, title: "Write docs", status: "open", ...fields }) as StoredRecord;
const event = (operation: WriteEvent["operation"], before: StoredRecord | null, after: StoredRecord | null) =>
  ({ id: "e1", type: `task.${operation}`, entity: "Task", operation, recordId: "t1", before, after, changed: [], cause: "write", actor: {}, at }) as unknown as WriteEvent;
const failure = (work: () => unknown): HttpError => {
  try {
    work();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("expected a failure");
};

describe("coverage", () => {
  test("tagged entities, all entities with list routes but @changes off, never internal or system ones", () => {
    const note = entityModel("Note", { text: field({ type: "string" }) });
    const internal = { ...entityModel("Audit", { line: field({ type: "string" }) }), internal: true };
    expect(changeEntities([tagged(task, true), note, internal], "tagged").map((model) => model.key)).toEqual(["Task"]);
    expect(changeEntities([tagged(task, false), note, internal, { ...note, key: "Log", system: true } as EntityModel], "all").map((model) => model.key)).toEqual(["Note"]);
  });
});

describe("the query", () => {
  test("filters, fields, exclude and events; paging parameters, unknown events and hidden fields answer 400 naming them", () => {
    const query = parseChangeQuery(task, new URLSearchParams("where[status][eq]=open&fields=title&events=created,deleted"), [task]);
    expect(query).toEqual({ where: [{ field: "status", op: "eq", value: "open" }], events: ["created", "deleted"], selection: { fields: ["title"] } });
    expect(parseChangeQuery(task, new URLSearchParams(""), [task]).events).toEqual(["created", "updated", "deleted"]);
    for (const [params, field] of [["sort=title", "sort"], ["limit=5", "limit"], ["offset=1", "offset"], ["events=moved", "events"], ["where[secret][eq]=x", "where[secret][eq]"], ["fields=nope", "fields"]] as [string, string][]) {
      const error = failure(() => parseChangeQuery(task, new URLSearchParams(params), [task]));
      expect([error.status, (error.details as { field: string }[]).map((detail) => detail.field)]).toEqual([400, [field]]);
    }
  });
});

describe("matching", () => {
  const open = parseChangeQuery(task, new URLSearchParams("where[status][eq]=open"), [task]);

  test("creates and deletes match on their record; updates on either side, with matches: false when the record left the filter", async () => {
    expect(await changeMessage(event("created", null, record({})), task, open)).toEqual({ event: "created", id: "e1", data: { id: "t1", type: "task.created", record: { id: "t1", createdAt: at, updatedAt: at, title: "Write docs", status: "open" } } });
    expect(await changeMessage(event("created", null, record({ status: "done" })), task, open)).toBeUndefined();
    const closed = await changeMessage(event("updated", record({}), record({ status: "done" })), task, open);
    expect([closed!.event, closed!.data.matches, (closed!.data.record as { status: string }).status]).toEqual(["updated", false, "done"]);
    expect((await changeMessage(event("updated", record({ status: "done" }), record({})), task, open))?.data.matches).toBeUndefined();
    expect(await changeMessage(event("updated", record({ status: "done" }), record({ status: "done", title: "x" })), task, open)).toBeUndefined();
    expect(await changeMessage(event("deleted", record({ status: "done" }), null), task, open)).toBeUndefined();
    expect((await changeMessage(event("deleted", record({}), null), task, open))?.event).toBe("deleted");
  });

  test("the event types and the field selection apply; hidden fields never appear", async () => {
    const deletes = parseChangeQuery(task, new URLSearchParams("events=deleted&fields=title"), [task]);
    expect(await changeMessage(event("created", null, record({ secret: "s" })), task, deletes)).toBeUndefined();
    expect((await changeMessage(event("deleted", record({ secret: "s" }), null), task, deletes))!.data.record).toEqual({ id: "t1", title: "Write docs" });
    const all = parseChangeQuery(task, new URLSearchParams(""), [task]);
    expect(Object.keys((await changeMessage(event("created", null, record({ secret: "s" })), task, all))!.data.record as object)).not.toContain("secret");
  });
});

describe("file records", () => {
  test("a file entity's record gets its url as on reads", async () => {
    const document = { ...entityModel("Document", { filename: field({ type: "string" }), url: { ...field({ type: "string" }), storage: "computed" } }), file: { base: "file" as const } };
    const query = parseChangeQuery(document, new URLSearchParams(""), [document]);
    const stored = { id: "f1", createdAt: at, updatedAt: at, filename: "a.pdf", storageKey: "documents/f1" } as StoredRecord;
    const created = { ...event("created", null, stored), recordId: "f1", type: "document.created" } as WriteEvent;
    const message = await changeMessage(created, document, query, { storage: { default: {} as never }, files: { signedUrlTtl: 60 } });
    expect((message!.data.record as { url: string }).url).toBe("/documents/f1/file");
  });
});

describe("the shared matcher", () => {
  test("agrees with the memory adapter on every operator", async () => {
    const adapter = memoryAdapter();
    await adapter.connect([task]);
    const rows = [
      record({ id: "a", title: "Alpha Report", status: "open", priority: 1, dueAt: new Date("2026-02-01T00:00:00Z") }),
      record({ id: "b", title: "beta notes", status: "done", priority: 5, dueAt: null }),
      record({ id: "c", title: "Gamma", status: "open", priority: null, dueAt: new Date("2026-03-01T00:00:00Z") }),
    ];
    for (const row of rows) await adapter.insert(task, row);
    const cases: Condition[][] = [
      [{ field: "title", op: "contains", value: "REPORT" }],
      [{ field: "title", op: "startsWith", value: "BETA" }],
      [{ field: "status", op: "in", value: ["done"] }],
      [{ field: "status", op: "nin", value: ["done"] }],
      [{ field: "status", op: "ne", value: "open" }],
      [{ field: "priority", op: "gt", value: 1 }],
      [{ field: "priority", op: "lte", value: 1 }],
      [{ field: "priority", op: "exists", value: true }],
      [{ field: "priority", op: "isNull", value: true }],
      [{ field: "dueAt", op: "gte", value: new Date("2026-02-01T00:00:00Z") }],
      [{ field: "dueAt", op: "lt", value: new Date("2026-02-15T00:00:00Z") }],
      [{ field: "dueAt", op: "exists", value: false }],
      [{ group: "or", conditions: [{ field: "status", op: "eq", value: "done" }, { field: "priority", op: "eq", value: 1 }] }],
    ];
    for (const where of cases) {
      const { data } = await adapter.findMany(task, { where, sort: [{ field: "id", direction: "asc" }], limit: 100, offset: 0 });
      expect([where, rows.filter((row) => matchesConditions(row, where, task)).map((row) => row.id)]).toEqual([where, data.map((row) => row.id)]);
    }
    // Dates written as text, as JSON copies of events hold them, compare as instants.
    expect(matchesConditions({ ...rows[0]!, dueAt: "2026-02-01T00:00:00.000Z" }, [{ field: "dueAt", op: "eq", value: new Date("2026-02-01T00:00:00Z") }], task)).toBe(true);
  });
});

describe("subscriptions", () => {
  test("an entity is listened to only while a stream of it is open", () => {
    const listening: string[] = [];
    const hub = changeHub((pattern) => {
      listening.push(pattern);
      return () => void listening.splice(listening.indexOf(pattern), 1);
    });
    expect(listening).toEqual([]);
    const first = hub.subscribe(task, () => undefined);
    const second = hub.subscribe(task, () => undefined);
    expect(listening).toEqual(["task.written"]);
    first();
    expect(hub.active()).toEqual(["Task"]);
    second();
    expect([listening, hub.active()]).toEqual([[], []]);
  });
});
