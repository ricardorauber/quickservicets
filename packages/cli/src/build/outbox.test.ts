import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addOutboxPatterns, events, readOutbox, tailOutbox, transaction, type EntityModel, type OutboxRecord } from "@quickservicets/core";
import { cleanOutbox } from "../../../core/src/features/events/outbox.ts";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const config = (events: string, adapter = "memoryAdapter()", extra = "") => `import { defineConfig, memoryAdapter, sqliteAdapter, postgresAdapter, mongodbAdapter } from "@quickservicets/core";
export default defineConfig({ database: ${adapter}, events: ${events}${extra} });
`;
const ENTITIES = {
  "entities/User.ts": "export type User = { name: string };\n",
  "entities/Order.ts": "export type Order = { item: string };\n",
};
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const types = async () => (await readOutbox({ limit: 1000 })).map((record) => record.type);

describe("the model", () => {
  test("the outbox adds the read-only system entity OutboxEvent, without routes or API docs", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("{ outbox: true }"), ...ENTITIES } });
    try {
      const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
      expect(models.find((model) => model.key === "OutboxEvent")).toMatchObject({ system: true, name: "outbox-events", repoKey: "outboxEvents", tableName: "outbox_events" });
      expect((await service.fetch("/outbox-events")).status).toBe(404);
      const openApi = readFileSync(join(service.root, ".generated/openapi.json"), "utf8");
      expect(openApi).not.toContain("OutboxEvent");
    } finally {
      await service.stop();
    }
  });

  const adapters = { sqlite: 'sqliteAdapter({ path: ":memory:" })', postgres: 'postgresAdapter({ url: "postgres://localhost/none" })' };
  for (const [name, adapter] of Object.entries(adapters)) {
    test(`${name}: migration add creates the outbox_events table`, async () => {
      const root = createLinkedProject({ "quickservicets.config.ts": config("{ outbox: true }", adapter), ...ENTITIES });
      const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
      expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?outbox_events/);
      expect(created).toMatch(/outbox_events_type_at|type", "at"|"type","at"/);
    });
  }

  test("mongodb: migration add creates the outbox indexes", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config("{ outbox: true }", 'mongodbAdapter({ url: "mongodb://localhost/none", database: "x" })'), ...ENTITIES });
    const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    // MongoDB names collections after the table name, like job_runs.
    expect(created).toContain('collection("outbox_events").createIndex({"type":1,"at":1}');
    expect(created).toContain('collection("outbox_events").createIndex({"at":1}');
  });

  test("without the outbox the model has no OutboxEvent and writes store nothing", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config("{}"), ...ENTITIES });
    await build(root);
    const models = (await import(join(root, ".generated/models.ts"))).models as EntityModel[];
    expect(models.some((model) => model.key === "OutboxEvent")).toBe(false);
    const service = await startTestService({ files: { "quickservicets.config.ts": config("{}"), ...ENTITIES } });
    try {
      expect((await service.fetch("/users", post({ name: "a" }))).status).toBe(201);
      expect((await failure(() => readOutbox())).message).toContain("The outbox is not enabled");
    } finally {
      await service.stop();
    }
  });
});

describe("storing events", () => {
  test("a write stores its event in its transaction; a rolled-back transaction stores none", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("{ outbox: true }"), ...ENTITIES } });
    try {
      const created = (await (await service.fetch("/users", post({ name: "a" }))).json()) as { id: string };
      const [row] = await readOutbox();
      expect(row).toMatchObject({ type: "user.created", event: { type: "user.created", recordId: created.id, after: { name: "a" } } });
      expect(row!.at).toBeInstanceOf(Date);
      const repos = service.repos as unknown as { users: { create(value: unknown): Promise<unknown> } };
      await failure(() =>
        transaction(async () => {
          await repos.users.create({ name: "b" });
          throw new Error("x");
        }),
      );
      expect(await types()).toEqual(["user.created"]);
    } finally {
      await service.stop();
    }
  });

  test("outbox.events filters by pattern; custom events outside a transaction are stored; other natives add patterns", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config('{ outbox: { events: ["order.*", "invoice.*"] } }'), ...ENTITIES } });
    try {
      await service.fetch("/orders", post({ item: "x" }));
      await service.fetch("/users", post({ name: "a" }));
      await events.emit("invoice.paid", { invoiceId: "i1" });
      expect(await types()).toEqual(["order.created", "invoice.paid"]);
      addOutboxPatterns(["user.*"]);
      await service.fetch("/users", post({ name: "b" }));
      expect(await types()).toEqual(["order.created", "invoice.paid", "user.created"]);
    } finally {
      await service.stop();
    }
  });

  test("a failing insert fails the write", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("{ outbox: true }"), ...ENTITIES } });
    try {
      const { adapter } = (await import("../../../core/src/features/events/outbox.ts")).outboxStore();
      const insert = adapter.insert;
      adapter.insert = (model, record) => (model.key === "OutboxEvent" ? Promise.reject(new Error("disk full")) : insert(model, record));
      expect((await service.fetch("/users", post({ name: "a" }))).status).toBe(500);
      adapter.insert = insert;
      expect(await (service.repos as unknown as { users: { query(): { all(): Promise<unknown[]> } } }).users.query().all()).toEqual([]);
    } finally {
      await service.stop();
    }
  });
});

describe("reading", () => {
  test("readOutbox pages in id order after a cursor and filters by type", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("{ outbox: true }"), ...ENTITIES } });
    try {
      for (const name of ["a", "b", "c", "d"]) await service.fetch("/users", post({ name }));
      await service.fetch("/orders", post({ item: "x" }));
      const all = await readOutbox();
      expect(all.map((record) => record.id)).toEqual([...all.map((record) => record.id)].sort());
      const page = await readOutbox({ after: all[1]!.id, limit: 2 });
      expect(page.map((record) => record.id)).toEqual([all[2]!.id, all[3]!.id]);
      expect((await readOutbox({ types: ["order.created"] })).map((record) => record.type)).toEqual(["order.created"]);
    } finally {
      await service.stop();
    }
  });

  test("tailOutbox delivers late commits behind its cursor exactly once", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("{ outbox: true }"), ...ENTITIES } });
    try {
      const received: OutboxRecord[] = [];
      const { adapter, model } = (await import("../../../core/src/features/events/outbox.ts")).outboxStore();
      const row = (id: string) => ({ id, createdAt: new Date(), updatedAt: new Date(), type: "invoice.paid", event: { id, type: "invoice.paid", at: new Date().toISOString() }, at: new Date() });
      const first = Bun.randomUUIDv7();
      const second = Bun.randomUUIDv7();
      const stop = tailOutbox({ onEvent: (record) => void received.push(record), pollInterval: "20ms" });
      try {
        // The later id commits first; the earlier one lands behind the cursor and is still delivered once.
        await adapter.insert(model, row(second));
        for (let attempt = 0; attempt < 100 && received.length < 1; attempt++) await Bun.sleep(10);
        await adapter.insert(model, row(first));
        for (let attempt = 0; attempt < 100 && received.length < 2; attempt++) await Bun.sleep(10);
        await Bun.sleep(100);
      } finally {
        stop();
      }
      expect(received.map((record) => record.id)).toEqual([second, first]);
    } finally {
      await service.stop();
    }
  });
});

describe("retention", () => {
  test("rows past the retention are deleted, newer ones kept, and QS_EVENTS_OUTBOX_RETENTION shortens it", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("{ outbox: true }"), ...ENTITIES } });
    try {
      const { adapter, model } = (await import("../../../core/src/features/events/outbox.ts")).outboxStore();
      const day = 86_400_000;
      const now = Date.UTC(2026, 5, 1);
      for (const age of [8, 6, 2]) {
        const at = new Date(now - age * day);
        await adapter.insert(model, { id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at, type: `age.d${age}`, event: {}, at });
      }
      expect(await cleanOutbox({ retentionMs: 7 * day, now })).toBe(1);
      expect((await types()).filter((type) => type.startsWith("age."))).toEqual(["age.d6", "age.d2"]);
      expect(await cleanOutbox({ retentionMs: day, now })).toBe(2);
    } finally {
      await service.stop();
    }
    const shortened = await startTestService({ files: { "quickservicets.config.ts": config("{ outbox: true }"), ...ENTITIES }, env: { QS_EVENTS_OUTBOX_RETENTION: "1d" } });
    try {
      const { eventsFeature } = await import("@quickservicets/core");
      expect(eventsFeature.options().outbox.retention).toBe("1d");
    } finally {
      await shortened.stop();
    }
  });
});
