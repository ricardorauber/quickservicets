import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { captureLogger, fakeClock, type FakeClock } from "./jobs/test-support.ts";
import type { QueueSettings } from "./features/queues/broker.ts";
import { databaseBroker, type DatabaseBrokerOptions } from "./features/queues/database.ts";
import { consumerHandler } from "./features/queues/handle.ts";
import type { MessagePlacement } from "./features/queues/message-options.ts";
import { queueMessageEntity, type QueueMessage } from "./features/queues/message.ts";
import type { QueueDefinition } from "./features/queues/queue.ts";
import type { AddSource } from "./features/queues/state.ts";
import type { Repositories } from "./hooks.ts";
import { inTransaction } from "./transactions.ts";

/** Helpers shared by the queue tests. */

export const model = queueMessageEntity();
export const DEFAULTS: QueueSettings = { concurrency: 1, timeout: "5m", retries: 3, retryDelay: "10s", maxRetryDelay: "1h" };

/** The options of `setUp`: the broker's, and the settings every queue gets. */
export type SetUpOptions = Partial<DatabaseBrokerOptions> & {
  concurrency?: number;
  timeout?: string;
  retries?: number;
  retryDelay?: string;
  maxRetryDelay?: string;
  /** The settings of every queue, instead of the defaults with the options above. */
  settings?: () => QueueSettings;
};

/**
 * A database broker over `adapter` with a fake clock, and `store`, the calls the native makes on it: enqueue a
 * message as `add` builds it, start consuming `definitions`, pause, stop and the optional methods.
 */
export function setUp(adapter: DatabaseAdapter, definitions: Record<string, QueueDefinition>, extra: SetUpOptions = {}) {
  const { logger, entries } = captureLogger();
  const clock = (extra.clock ?? fakeClock()) as FakeClock;
  const settings = (): QueueSettings =>
    extra.settings?.() ?? {
      ...DEFAULTS,
      ...(extra.concurrency ? { concurrency: extra.concurrency } : {}),
      ...(extra.timeout ? { timeout: extra.timeout } : {}),
      ...(extra.retries !== undefined ? { retries: extra.retries } : {}),
      ...(extra.retryDelay ? { retryDelay: extra.retryDelay } : {}),
      ...(extra.maxRetryDelay ? { maxRetryDelay: extra.maxRetryDelay } : {}),
    };
  const pollInterval = extra.pollInterval ?? "1s";
  const broker = databaseBroker({
    adapter,
    model,
    pollInterval,
    logger,
    production: extra.production ?? false,
    resultLimit: extra.resultLimit ?? "64KB",
    worker: extra.worker ?? "test:1",
    clock,
    queues: Object.keys(definitions),
    ...(extra.random ? { random: extra.random } : {}),
    ...(extra.retention ? { retention: extra.retention } : {}),
  });
  const store = {
    enqueue(name: string, payload: unknown, source: AddSource = {}, placement?: MessagePlacement) {
      const { retries, dedupeWindow } = settings();
      return broker.enqueue(
        {
          queue: name,
          payload,
          runAt: placement?.runAt ?? new Date(clock.now()),
          priority: placement?.priority ?? 0,
          maxAttempts: retries + 1,
          ...(placement?.dedupeKey !== undefined ? { dedupeKey: placement.dedupeKey } : {}),
          ...(dedupeWindow ? { dedupeWindow } : {}),
          ...(source.requestId ? { requestId: source.requestId } : {}),
        },
        { transactional: inTransaction() },
      );
    },
    start(repos: Repositories) {
      return broker.start({
        queues: Object.keys(definitions).map((name) => ({ name, options: settings() })),
        handle: consumerHandler({ definitions: new Map(Object.entries(definitions)), repos: () => repos, logger, clock }),
        pollInterval,
        logger,
        clock,
      });
    },
    stop: () => broker.pause(),
    drain: (graceMs: number) => broker.stop({ graceMs }),
    retry: (id: string) => broker.retry(id),
    retryDead: (queue: string) => broker.retryDead(queue),
    dead: (queue: string, options?: { limit?: number }) => broker.dead(queue, options),
    stats: () => broker.stats(),
    cleanup: () => broker.cleanup(),
    reclaim: () => broker.reclaim(),
    wake: (name: string) => broker.wake(name),
    running: () => broker.running(),
  };
  return { store, broker, clock, entries };
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
