import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { captureLogger, fakeClock, type FakeClock } from "./jobs/test-support.ts";
import { createDatabaseQueue, type DatabaseQueueOptions } from "./features/queues/database.ts";
import { queueMessageEntity, type QueueMessage } from "./features/queues/message.ts";
import type { QueueDefinition } from "./features/queues/queue.ts";

/** Helpers shared by the queue tests. */

export const model = queueMessageEntity();
export const DEFAULTS = { concurrency: 1, timeout: "5m", retries: 3, retryDelay: "10s", maxRetryDelay: "1h" };

export function setUp(
  adapter: DatabaseAdapter,
  definitions: Record<string, QueueDefinition>,
  extra: Partial<DatabaseQueueOptions> & { concurrency?: number; timeout?: string; retries?: number; retryDelay?: string; maxRetryDelay?: string } = {},
) {
  const { logger, entries } = captureLogger();
  const clock = (extra.clock ?? fakeClock()) as FakeClock;
  const store = createDatabaseQueue({
    adapter,
    model,
    definitions: new Map(Object.entries(definitions)),
    settings: () => ({
      ...DEFAULTS,
      ...(extra.concurrency ? { concurrency: extra.concurrency } : {}),
      ...(extra.timeout ? { timeout: extra.timeout } : {}),
      ...(extra.retries !== undefined ? { retries: extra.retries } : {}),
      ...(extra.retryDelay ? { retryDelay: extra.retryDelay } : {}),
      ...(extra.maxRetryDelay ? { maxRetryDelay: extra.maxRetryDelay } : {}),
    }),
    pollInterval: "1s",
    logger,
    production: false,
    resultLimit: "64KB",
    worker: "test:1",
    ...extra,
    clock,
  });
  return { store, clock, entries };
}

export async function memory() {
  const adapter = memoryAdapter();
  await adapter.connect([model]);
  return adapter;
}

export const all = async (adapter: DatabaseAdapter) =>
  (await adapter.findMany(model, { where: [], sort: [{ field: "id", direction: "asc" }], limit: 10_000, offset: 0, withTotal: false })).data as unknown as QueueMessage[];

export const until = async (check: () => Promise<boolean> | boolean, clock?: FakeClock) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return;
    if (clock) await clock.flush();
    else await Bun.sleep(5);
  }
  throw new Error("timed out waiting");
};

