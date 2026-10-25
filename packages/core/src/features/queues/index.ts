import {
  boolean,
  defineFeature,
  duration,
  hook,
  inTransaction,
  integer,
  list,
  object,
  oneOf,
  parseDuration,
  provider,
  record,
  resolveOption,
  runAfterHooks,
  runBeforeHooks,
  safeLog,
  string,
  systemClock,
  type EntityModel,
  type FeatureSetupContext,
  type Repositories,
  type WriteEvent,
} from "../public.ts";
import { brokerMethod, type QueueBroker, type QueueBrokerMessage, type QueueOutcomeReport, type QueueSettings } from "./broker.ts";
import type { QueueDeadMessage, QueueEnqueueContext, QueueEnqueued, QueueEnqueueStep, QueueMessageEvent, QueueProcessed, QueueProcessStep, QueuesApi } from "./api.ts";
import { consumerHandler } from "./handle.ts";
import { queueClient } from "./client.ts";
import { queueCommands } from "./commands.ts";
import { bindDatabaseBroker, databaseBroker, isDatabaseBroker } from "./database.ts";
import { messagePlacement } from "./message-options.ts";
import { queueMessageEntity } from "./message.ts";
import { PUBLISH_OPERATIONS, publishedPayload, type PublishSettings } from "./publish.ts";
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
      dedupeWindow: duration().optional().describe("How long a completed message of the queue keeps deduplicating its key."),
    }),
  ).describe("Options of single queues by queue name, over the queue file's options."),
  defaultPriority: integer()
    .min(-100)
    .max(100)
    .default(0)
    .perRequest()
    .describe("The priority of req.queue.add calls that give none; a function of the request, its user and tenant sets it per request."),
  defaultDelay: duration()
    .optional()
    .perRequest()
    .describe("The delay of req.queue.add calls that give neither delay nor runAt; a function of the request sets it per request."),
  beforeEnqueue: hook<QueueEnqueueStep, QueueEnqueueContext>().describe("Runs before a message is added with the queue, payload and options; returns them changed, and a throw cancels the add."),
  afterEnqueue: hook<QueueEnqueued, undefined>().describe("Runs after a message was added, with its queue, id and whether it was deduplicated."),
  beforeProcess: hook<QueueProcessStep, undefined>().describe("Runs before a consumer with the message and payload; returns a changed payload, and a throw fails the attempt."),
  afterProcess: hook<QueueProcessed, undefined>().describe("Runs after each run with the message, its status, result or error and duration."),
  onDead: hook<QueueDeadMessage, undefined>().describe("Runs when a message used its last attempt, with the message and the error."),
  broker: provider<QueueBroker>("QueueBroker", ["enqueue", "start", "stop", "stats"])
    .optional()
    .describe("Replaces the database broker, so messages live in another broker such as RabbitMQ, Kafka, Redis or SQS."),
  publish: object({
    queue: string().default("events").describe("The queue an entity tagged @publish sends its write events to."),
    events: list(oneOf(PUBLISH_OPERATIONS))
      .default([...PUBLISH_OPERATIONS])
      .describe("The write operations a tagged entity publishes: created, updated and deleted."),
    fields: list(string()).optional().describe("The only fields, with id, kept in a published event's before and after; all but hidden and sensitive fields without it."),
  })
    .default({})
    .describe("Where and what entities tagged @publish send: each write event becomes a message, added in the write's transaction."),
});

const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/** Undoes the process-wide state of the running service's setup. */
const lifecycle = sharedState("lifecycle", () => ({ teardown: undefined as (() => void) | undefined }));

/** The broker set by `queues.broker` or a feature's `setBroker`, with who set it. */
const brokers = sharedState("broker", () => ({ choice: undefined as { broker: QueueBroker; owner: string } | undefined }));

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
  // Publishing write events needs the events native when an entity uses @publish; it runs first when enabled.
  after: ["events"],
  entities: () => [queueMessageEntity()],
  tags: {
    publish: {
      on: ["entity"],
      scope: "publish",
      options: ["events", "queue", "fields"],
      shorthand: "events",
      description: "`@publish` sends the entity's write events to a queue (`publish.queue`, default `events`) in the write's transaction; `events` limits the operations, `fields` the fields of `before` and `after`.",
      example: "/** @publish created,updated queue=crm-sync */\nexport type User = { email: string };",
    },
  },
  folders: {
    queues: {
      dir: "queues",
      featurePrefix: true,
      check: (value) => isQueueDefinition(value) || "must default-export queue(...)",
      description: "Queue consumers: each default-exports queue(handler, options?), named by its path without extension.",
    },
  },
  request: {
    queue: (req) => queueClient({ requestId: req.id, req }),
  },
  commands: queueCommands,
  setup(ctx) {
    lifecycle.teardown?.();
    const model = ctx.models.find((candidate) => candidate.key === "QueueMessage" && candidate.system);
    if (!model) throw new Error("The queues native needs the QueueMessage entity; run quickservice build after enabling it");
    const declared = new Map<string, QueueDefinition>();
    for (const [name, file] of ctx.folders.queues ?? []) if (isQueueDefinition(file)) declared.set(name, file);
    const names = new Set(declared.keys());
    // Entities tagged @publish send their write events to a queue, which add then knows.
    const publishing = ctx.models.flatMap((entity) => {
      if (entity.system || entity.link) return [];
      const target = queuesFeature.optionsFor(entity);
      return target.on === true ? [{ entity, settings: target.publish as PublishSettings }] : [];
    });
    for (const { settings } of publishing) names.add(settings.queue);
    // A queue's options: its overrides (environment, then config), its file, then the queues options.
    const settingsOf = (name: string): QueueSettings => {
      const file = declared.get(name)?.options ?? {};
      const override = ctx.options.overrides[name] ?? {};
      const dedupeWindow = override.dedupeWindow ?? file.dedupeWindow;
      return {
        concurrency: override.concurrency ?? file.concurrency ?? ctx.options.concurrency,
        timeout: override.timeout ?? file.timeout ?? ctx.options.timeout,
        retries: override.retries ?? file.retries ?? ctx.options.retries,
        retryDelay: override.retryDelay ?? file.retryDelay ?? ctx.options.retryDelay,
        maxRetryDelay: ctx.options.maxRetryDelay,
        ...(dedupeWindow ? { dedupeWindow } : {}),
      };
    };
    for (const warning of overrideWarnings(Object.keys(ctx.options.overrides), names)) {
      if (ctx.config.warnings.includes(warning)) continue;
      ctx.config.warnings.push(warning);
      safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "config.warning", warning });
    }
    // The configured broker, or one a feature sets during its setup, or the database broker.
    const configured = ctx.options.broker as QueueBroker | undefined;
    brokers.choice = configured ? { broker: configured, owner: "queues.broker" } : undefined;
    const databaseDefaults = {
      adapter: ctx.config.database,
      model,
      pollInterval: ctx.options.pollInterval,
      logger: ctx.logger,
      production: ctx.config.production,
      resultLimit: ctx.config.jobs.limits.result,
      retention: ctx.options.retention,
      queues: [...declared.keys()],
    };
    const fallback = databaseBroker();
    let chosen: QueueBroker | undefined;
    const brokerOf = (): QueueBroker => {
      if (chosen) return chosen;
      chosen = brokers.choice?.broker ?? fallback;
      if (isDatabaseBroker(chosen)) bindDatabaseBroker(chosen, databaseDefaults);
      return chosen;
    };

    /** The per-request defaults of `req.queue.add`, for the options a call leaves out. */
    const withRequestDefaults = async (options: QueueEnqueueStep["options"], req: NonNullable<QueueEnqueueContext["req"]>) => {
      const filled = { ...options };
      if (filled.priority === undefined) filled.priority = await resolveOption(ctx.options.defaultPriority, { req });
      if (filled.delay === undefined && filled.runAt === undefined && ctx.options.defaultDelay !== undefined) {
        const delay = await resolveOption(ctx.options.defaultDelay, { req });
        if (delay !== undefined) filled.delay = delay;
      }
      return filled;
    };

    // Every outcome a broker reports runs the hooks and becomes an event when `events` is enabled.
    const eventsEnabled = ctx.config.features.some((feature) => feature.key === "events");
    const emit = async (type: string, payload: QueueMessageEvent) => {
      if (!eventsEnabled) return;
      try {
        await ctx.events.emit(type as never, payload as never);
      } catch (error) {
        safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "queue.event.failed", type, error: { message: (error as Error)?.message ?? String(error) } });
      }
    };
    const errorOf = (error: unknown) => ({ message: (error as Error)?.message ?? String(error) });
    const report = (outcome: QueueOutcomeReport) => {
      const { message } = outcome;
      const event: QueueMessageEvent = { messageId: message.id, queue: message.queue, attempt: message.attempt };
      void (async () => {
        if (outcome.type === "dead") {
          if (ctx.options.onDead.length > 0) await runAfterHooks(ctx.options.onDead, { message, error: outcome.error }, undefined);
          await emit("queue.message.dead", { ...event, error: errorOf(outcome.error) });
          return;
        }
        const processed: QueueProcessed =
          outcome.type === "completed"
            ? { message, status: "completed", result: outcome.result, durationMs: outcome.durationMs }
            : { message, status: "failed", error: outcome.error, durationMs: outcome.durationMs };
        if (ctx.options.afterProcess.length > 0) await runAfterHooks(ctx.options.afterProcess, processed, undefined);
        await emit(`queue.message.${outcome.type}`, { ...event, durationMs: outcome.durationMs, ...(outcome.type === "failed" ? { error: errorOf(outcome.error) } : {}) });
      })();
    };
    const beforeProcess =
      ctx.options.beforeProcess.length > 0
        ? async (message: QueueProcessStep["message"], payload: unknown) => (await runBeforeHooks(ctx.options.beforeProcess, { message, payload }, undefined)).payload
        : undefined;

    let repos: Repositories | undefined;
    const native: RunningQueues = {
      async add(requested, requestedPayload, requestedOptions, source) {
        let step: QueueEnqueueStep = { queue: requested, payload: requestedPayload, options: requestedOptions ?? {} };
        if (ctx.options.beforeEnqueue.length > 0) step = await runBeforeHooks(ctx.options.beforeEnqueue, step, { req: source.req });
        const name = step.queue;
        if (!names.has(name)) throw new Error(`Unknown queue ${name}`);
        const stored = jsonPayload(step.payload);
        if (stored === undefined) throw new Error(`Queue payload for ${name} is not JSON-serializable`);
        const options = source.req ? await withRequestDefaults(step.options, source.req) : step.options;
        const { runAt, priority, dedupeKey } = messagePlacement(options, Date.now());
        const settings = settingsOf(name);
        const message: QueueBrokerMessage = {
          queue: name,
          payload: stored,
          runAt,
          priority,
          maxAttempts: settings.retries + 1,
          ...(dedupeKey !== undefined ? { dedupeKey } : {}),
          ...(settings.dedupeWindow ? { dedupeWindow: settings.dedupeWindow } : {}),
          ...(source.requestId ? { requestId: source.requestId } : {}),
        };
        const added = await brokerOf().enqueue(message, { transactional: inTransaction() });
        if (ctx.options.afterEnqueue.length > 0) await runAfterHooks(ctx.options.afterEnqueue, { queue: name, id: added.id, deduplicated: added.deduplicated }, undefined);
        return added;
      },
      retry: async (id) => brokerMethod(brokerOf(), "retry")(id),
      retryDead: async (queue) => brokerMethod(brokerOf(), "retryDead")(queue),
    };
    running.current = native;
    if (publishing.length > 0) publishWrites(ctx, publishing, (queue, payload, event) => native.add(queue, payload, { dedupeKey: event.id }, event.requestId ? { requestId: event.requestId } : {}));
    const stop = () => {
      lifecycle.teardown = undefined;
      brokers.choice = undefined;
      if (running.current === native) running.current = undefined;
    };
    lifecycle.teardown = stop;
    // onStop callbacks run in reverse order, so this one runs last, after the consumers drained.
    ctx.app.onStop(stop);
    // Brokers can no longer be set once every setup ran.
    ctx.app.onStart(() => void brokerOf());
    if (!ctx.options.consume) return;
    ctx.app.onStart(async (start) => {
      repos = start.repos;
      await brokerOf().start({
        queues: [...declared.keys()].map((name) => ({ name, options: settingsOf(name) })),
        handle: consumerHandler({ definitions: declared, repos: () => repos!, logger: ctx.logger, ...(beforeProcess ? { beforeProcess } : {}) }),
        report,
        pollInterval: ctx.options.pollInterval,
        logger: ctx.logger,
        clock: systemClock,
      });
    });
    ctx.app.onShutdown(() => brokerOf().pause?.());
    // Within the stop limit, so the lifecycle's own timeout never cuts the drain short.
    const stopLimit = Math.floor((parseDuration(ctx.config.lifecycle.stopTimeout) ?? 10_000) * 0.9);
    ctx.app.onStop(() => brokerOf().stop({ graceMs: Math.min(parseDuration(ctx.config.jobs.shutdownGrace) ?? 10_000, stopLimit) }));
  },
  api: (ctx): QueuesApi => ({
    setBroker(broker) {
      const caller = ctx.currentFeature();
      if (!caller || caller === "queues") throw new Error("setBroker is only available during the setup of another feature");
      const problem = brokerProblem(broker);
      if (problem) throw new Error(`Invalid broker set by ${caller}: ${problem}`);
      if (brokers.choice) throw new Error(`Queue broker set by ${brokers.choice.owner} and ${caller}; keep one`);
      brokers.choice = { broker, owner: caller };
    },
    addHook: ctx.addHook as QueuesApi["addHook"],
  }),
});

/** One warning per `queues.overrides` entry whose name is no queue of the project. */
export function overrideWarnings(overrides: readonly string[], queues: ReadonlySet<string>): string[] {
  return overrides.filter((name) => !queues.has(name)).map((name) => `queues.overrides.${name} matches no queue`);
}

/** The required methods of a broker, as the `broker` option checks them. */
const BROKER_METHODS = ["enqueue", "start", "stop", "stats"] as const;

/** Why a value is not a broker, or undefined when it is one. */
function brokerProblem(broker: unknown): string | undefined {
  if (typeof broker !== "object" || broker === null) return "expected a QueueBroker object";
  const missing = BROKER_METHODS.filter((method) => typeof (broker as Record<string, unknown>)[method] !== "function");
  return missing.length > 0 ? `the QueueBroker is missing ${missing.join(", ")}` : undefined;
}

/** Adds an `inTransaction` listener per tagged entity that adds one message per listed write event. */
function publishWrites(
  ctx: Pick<FeatureSetupContext, "config" | "feature">,
  publishing: { entity: EntityModel; settings: PublishSettings }[],
  add: (queue: string, payload: unknown, event: WriteEvent) => Promise<unknown>,
): void {
  if (!ctx.config.features.some((feature) => feature.key === "events")) {
    const names = publishing.map(({ entity }) => entity.entityName).join(", ");
    throw new Error(`queues requires events; add events: {} to quickservice.config.ts (@publish on ${names} sends write events)`);
  }
  for (const { entity, settings } of publishing) {
    const payloadOf = publishedPayload(entity, settings);
    const listener = async (event: WriteEvent) => {
      if (event.entity !== entity.entityName || !settings.events.includes(event.operation)) return;
      // Inside the write's transaction: the message exists exactly when the write commits.
      await add(settings.queue, payloadOf(event), event);
    };
    ctx.feature("events").on(`${lowerFirst(entity.entityName)}.*`, listener as never, { phase: "inTransaction" });
  }
}

export default queuesFeature;
export { queuesFeature };
export { queues } from "./client.ts";
export { QUEUE_MESSAGE_STATUSES, queueMessageEntity } from "./message.ts";
export { isQueueDefinition, queue } from "./queue.ts";
export type { QueueMessage, QueueMessageStatus } from "./message.ts";
export type { QueueAddOptions, QueueAddResult, QueueClient, QueueContext, QueueDefinition, QueueMessageInfo, QueueName, QueueOptions, QueuePayloadOf, QueuePayloads, Queues } from "./queue.ts";
export { databaseBroker } from "./database.ts";
export type { DatabaseBroker, DatabaseBrokerOptions } from "./database.ts";
export type { QueueBroker, QueueBrokerContext, QueueBrokerMessage, QueueOutcome, QueueOutcomeReport, QueueReceivedMessage, QueueSettings, QueueStats } from "./broker.ts";
export type { QueueDeadMessage, QueueEnqueueContext, QueueEnqueued, QueueEnqueueStep, QueueMessageEvent, QueueProcessed, QueueProcessStep, QueuesApi } from "./api.ts";
