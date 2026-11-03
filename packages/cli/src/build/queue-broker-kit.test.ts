import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerProjectFeatures } from "@quickservicets/core";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";

afterEach(() => registerProjectFeatures([]));

/** A project feature following the broker conventions: its own key, `enables: ["queues"]`, the kit's dedupe entity. */
const BROKER_FEATURE = `import { brokerName, createConsumerPool, createDedupeStore, decodeQueueMessage, defineFeature, encodeQueueMessage, object, queueDedupeEntity, string, type QueueBroker } from "@quickservicets/core";

export default defineFeature({
  key: "membroker",
  enables: ["queues"],
  options: object({ prefix: string().default("quickservicets.").describe("The prefix of broker queue names.") }),
  entities: [queueDedupeEntity],
  setup(ctx) {
    const topics = new Map<string, string[]>();
    const dedupe = createDedupeStore({ adapter: ctx.config.database });
    let stopped = false;
    let pool: ReturnType<typeof createConsumerPool> | undefined;
    const broker: QueueBroker = {
      name: "membroker",
      async enqueue(message) {
        const id = Bun.randomUUIDv7();
        if (message.dedupeKey) {
          const claim = await dedupe.claim({ queue: message.queue, dedupeKey: message.dedupeKey, messageId: id });
          if (!claim.claimed) return { id: claim.messageId, deduplicated: true };
        }
        const name = brokerName(message.queue, ctx.options.prefix);
        const list = topics.get(name) ?? [];
        list.push(encodeQueueMessage({ ...message, id, attempt: 1, enqueuedAt: new Date() }));
        topics.set(name, list);
        (globalThis as unknown as { brokerTopics: string[] }).brokerTopics.push(name);
        return { id, deduplicated: false };
      },
      start(start) {
        pool = createConsumerPool({ queues: start.queues, handle: start.handle });
        const loop = async () => {
          while (!stopped) {
            for (const [name, list] of topics) {
              const text = list.shift();
              if (!text) continue;
              const message = decodeQueueMessage(text);
              await pool!.push(message.queue, { ...message }, {
                ack: () => (message.dedupeKey ? dedupe.release({ queue: message.queue, dedupeKey: message.dedupeKey, messageId: message.id }) : undefined),
                nack: () => undefined,
              });
              void name;
            }
            await Bun.sleep(10);
          }
        };
        void loop();
      },
      async stop({ graceMs }) {
        stopped = true;
        await pool?.drain(graceMs);
      },
      async stats() {
        return {};
      },
    };
    ctx.feature("queues").setBroker(broker);
  },
});
`;
const QUEUE = 'import { queue } from "@quickservicets/core";\nexport default queue<{ to: string }>(async ({ payload }) => void (globalThis as unknown as { sent: string[] }).sent.push(payload.to));\n';
const ENDPOINT = `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", { to: "a@b.c" }, { dedupeKey: "welcome" });
`;
const config = (keys: string, adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ database: ${adapter}, logger: { info() {}, warn() {}, error() {} }, ${keys} });
`;

describe("an external broker built with the kit", () => {
  test("a feature following the conventions works from its own key, without a queues key, and replaces the database broker", async () => {
    const state = globalThis as unknown as { sent: string[]; brokerTopics: string[] };
    state.sent = [];
    state.brokerTopics = [];
    const service = await startTestService({
      files: { "quickservicets.config.ts": config("membroker: {}"), "features/membroker/index.ts": BROKER_FEATURE, "queues/send-email.ts": QUEUE, "endpoints/welcome/post.ts": ENDPOINT },
    });
    try {
      const first = (await (await service.fetch("/welcome", { method: "POST" })).json()) as { id: string; deduplicated: boolean };
      const second = (await (await service.fetch("/welcome", { method: "POST" })).json()) as { id: string; deduplicated: boolean };
      expect(second).toEqual({ id: first.id, deduplicated: true });
      for (let index = 0; index < 200 && state.sent.length === 0; index++) await Bun.sleep(10);
      expect(state.sent).toEqual(["a@b.c"]);
      expect(state.brokerTopics).toEqual(["quickservicets.send-email"]);
      // The database broker stored nothing.
      expect(await (service.repos as unknown as { queueMessages: { query(): { toArray(): Promise<unknown[]> } } }).queueMessages.query().toArray()).toEqual([]);
    } finally {
      await service.stop();
    }
  }, 20_000);

  test("migration add creates queue_dedupe_keys for the feature, and a project with the database broker has no such table", async () => {
    const withBroker = createLinkedProject({ "quickservicets.config.ts": config("membroker: {}", 'sqliteAdapter({ path: ":memory:" })'), "features/membroker/index.ts": BROKER_FEATURE, "queues/send-email.ts": QUEUE });
    const created = readFileSync(join(withBroker, (await addMigration(withBroker, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?queue_dedupe_keys/);
    registerProjectFeatures([]);
    const plain = createLinkedProject({ "quickservicets.config.ts": config("queues: {}", 'sqliteAdapter({ path: ":memory:" })'), "queues/send-email.ts": QUEUE });
    const database = readFileSync(join(plain, (await addMigration(plain, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(database).toContain("queue_messages");
    expect(database).not.toContain("queue_dedupe_keys");
  });
});
