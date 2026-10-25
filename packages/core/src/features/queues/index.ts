import { boolean, defineFeature, duration, integer, object, parseDuration, record } from "../public.ts";
import { queueClient } from "./client.ts";
import { queueCommands } from "./commands.ts";
import { createDatabaseQueue, type QueueSettings } from "./database.ts";
import { messagePlacement } from "./message-options.ts";
import { queueMessageEntity } from "./message.ts";
import { isQueueDefinition, type QueueDefinition } from "./queue.ts";
import { running, sharedState, type RunningQueues } from "./state.ts";

const options = object({
  consume: boolean().default(true).describe("Runs the consumers in this process; false keeps add working in processes that only enqueue."),
  concurrency: integer().min(1).default(1).describe("How many messages of each queue run at once in one process."),
  pollInterval: duration().default("1s").describe("How long an idle consumer waits before it looks for messages again."),
  timeout: duration().default("5m").describe("The longest a message may run; the lease of a claimed message."),
  retries: integer().min(0).default(3).describe("How many times a failed message is retried before it is dead."),
  retryDelay: duration().default("10s").describe("The delay before the first retry, doubled for each next one."),
  maxRetryDelay: duration().default("1h").describe("The longest delay between two attempts."),
  retention: object({
    completed: duration().default("7d").describe("How long completed messages are kept after they finish."),
    dead: duration().default("30d").describe("How long dead messages are kept after they finish."),
  })
    .default({})
    .describe("How long finished messages are kept."),
  overrides: record(
    object({
      concurrency: integer().min(1).optional().describe("How many messages of the queue run at once in one process."),
      timeout: duration().optional().describe("The longest a message of the queue may run."),
      retries: integer().min(0).optional().describe("How many times a failed message of the queue is retried."),
      retryDelay: duration().optional().describe("The first retry delay of the queue."),
    }),
  ).describe("Options of single queues by queue name, over the queue file's options."),
});

/** Undoes the process-wide state of the running service's setup. */
const lifecycle = sharedState("lifecycle", () => ({ teardown: undefined as (() => void) | undefined }));

/** The JSON form of a payload, or undefined when it has none. */
function jsonPayload(payload: unknown): unknown {
  try {
    const text = JSON.stringify(payload);
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * The `queues` native: queue consumers declared as files in `queues/`, and typed messages added to them from endpoints,
 * hooks, jobs and any other code, stored in the project's own database. Off unless `queues: {}` (or
 * `QS_QUEUES_ENABLED=true`) is set.
 */
const queuesFeature = defineFeature({
  key: "queues",
  docs: { summary: "Background queues stored in the project's database, with consumers declared as files in queues/." },
  options,
  entities: () => [queueMessageEntity()],
  folders: {
    queues: {
      dir: "queues",
      featurePrefix: true,
      check: (value) => isQueueDefinition(value) || "must default-export queue(...)",
      description: "Queue consumers: each default-exports queue(handler, options?), named by its path without extension.",
    },
  },
  request: {
    queue: (req) => queueClient({ requestId: req.id }),
  },
  commands: queueCommands,
  setup(ctx) {
    lifecycle.teardown?.();
    const model = ctx.models.find((candidate) => candidate.key === "QueueMessage" && candidate.system);
    if (!model) throw new Error("The queues native needs the QueueMessage entity; run quickservice build after enabling it");
    const adapter = ctx.config.database;
    const declared = new Map<string, QueueDefinition>();
    for (const [name, file] of ctx.folders.queues ?? []) if (isQueueDefinition(file)) declared.set(name, file);
    const names = new Set(declared.keys());
    const settingsOf = (name: string): QueueSettings => {
      const file = declared.get(name)?.options ?? {};
      return {
        concurrency: file.concurrency ?? ctx.options.concurrency,
        timeout: file.timeout ?? ctx.options.timeout,
        retries: file.retries ?? ctx.options.retries,
        retryDelay: file.retryDelay ?? ctx.options.retryDelay,
        maxRetryDelay: ctx.options.maxRetryDelay,
      };
    };
    const store = createDatabaseQueue({
      adapter: ctx.config.database,
      model,
      definitions: declared,
      settings: settingsOf,
      pollInterval: ctx.options.pollInterval,
      logger: ctx.logger,
      production: ctx.config.production,
      resultLimit: ctx.config.jobs.limits.result,
      retention: ctx.options.retention,
    });

    const native: RunningQueues = {
      async add(name, payload, options, source) {
        if (!names.has(name)) throw new Error(`Unknown queue ${name}`);
        const stored = jsonPayload(payload);
        if (stored === undefined) throw new Error(`Queue payload for ${name} is not JSON-serializable`);
        return store.enqueue(name, stored, source, messagePlacement(options, Date.now()));
      },
      retry: (id) => store.retry(id),
      retryDead: (queue) => store.retryDead(queue),
    };
    running.current = native;
    const stop = () => {
      lifecycle.teardown = undefined;
      if (running.current === native) running.current = undefined;
    };
    lifecycle.teardown = stop;
    // onStop callbacks run in reverse order, so this one runs last, after the consumers drained.
    ctx.app.onStop(stop);
    if (!ctx.options.consume) return;
    ctx.app.onStart((start) => store.start(start.repos));
    ctx.app.onShutdown(() => store.stop());
    // Within the stop limit, so the lifecycle's own timeout never cuts the drain short.
    const stopLimit = Math.floor((parseDuration(ctx.config.lifecycle.stopTimeout) ?? 10_000) * 0.9);
    ctx.app.onStop(() => store.drain(Math.min(parseDuration(ctx.config.jobs.shutdownGrace) ?? 10_000, stopLimit)));
  },
});

export default queuesFeature;
export { queuesFeature };
export { queues } from "./client.ts";
export { QUEUE_MESSAGE_STATUSES, queueMessageEntity } from "./message.ts";
export { isQueueDefinition, queue } from "./queue.ts";
export type { QueueMessage, QueueMessageStatus } from "./message.ts";
export type { QueueAddOptions, QueueAddResult, QueueClient, QueueContext, QueueDefinition, QueueMessageInfo, QueueName, QueueOptions, QueuePayloadOf, QueuePayloads, Queues } from "./queue.ts";
export type { QueueStats } from "./database.ts";
