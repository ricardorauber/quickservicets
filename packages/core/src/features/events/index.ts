import {
  boolean,
  defineFeature,
  disableOperationContext,
  duration,
  enableOperationContext,
  hook,
  integer,
  list,
  object,
  observeWrites,
  operationMiddleware,
  parseDuration,
  provider,
  safeLog,
  string,
  toggle,
  type AnyEvent,
  type EntityModel,
  type OperationInfo,
} from "../public.ts";
import { events, pendingDeliveries, publish, startBus, stopBus, toEvent, type EventBus, type EventListener } from "./bus.ts";
import { eventCommands } from "./commands.ts";
import { clearConsumers, createDispatcher, outboxDeliveryEntity, removeDeliveries, undeliveredEvents, type Dispatcher } from "./delivery.ts";
import { isListenerFile, type ListenerContext } from "./listen.ts";
import { cleanOutbox, outboxEventEntity, outboxPatterns, startOutbox, stopOutbox } from "./outbox.ts";
import { sharedState } from "./state.ts";
import type { EventsApi } from "./api.ts";

/** How often every worker that runs scheduled work deletes outbox rows past their retention. */
export const OUTBOX_CLEANUP_INTERVAL = 3_600_000;

/** Undoes the process-wide state of the running service's setup: observers, operation context, outbox and listeners. */
const lifecycle = sharedState("lifecycle", () => ({ teardown: undefined as (() => void) | undefined }));

const options = object({
  outbox: toggle({
    events: list(string()).default(["*"]).describe("The event patterns stored in the outbox."),
    retention: duration().default("7d").describe("How long outbox rows are kept; rows with undelivered deliveries stay."),
    dispatch: boolean().default(true).describe("Runs the delivery dispatcher in this worker."),
    delivery: object({
      pollInterval: duration().default("1s").describe("How often the dispatcher looks for due deliveries."),
      batch: integer().min(1).default(100).describe("Deliveries claimed per poll."),
      timeout: duration().default("30s").describe("How long a delivery may run before it is aborted and retried; the lease of a claimed row."),
      retries: integer().min(1).default(10).describe("Failed attempts before a delivery becomes failed."),
      retryDelay: duration().default("10s").describe("The first retry delay, doubled each attempt."),
      maxRetryDelay: duration().default("1h").describe("The longest retry delay."),
    }),
  })
    .default(false)
    .describe("Stores the chosen events in the write's transaction, so any worker or replica reads every committed event."),
  beforeEmit: hook<AnyEvent | null, { operation: OperationInfo | undefined }>().describe(
    "Runs before an event reaches any listener or the outbox; returns a changed event or null to drop it, and a throw fails the write.",
  ),
  afterEmit: hook<AnyEvent, undefined>().describe("Runs after an event was stored and handed to after-commit dispatch."),
  bus: provider<EventBus>("EventBus", ["publish", "subscribe"]).optional().describe("Replaces the in-process after-commit dispatch; in-transaction listeners and the outbox stay."),
});

/**
 * The `events` native: every write of a non-system entity becomes a `WriteEvent`, delivered to listeners inside the
 * write's transaction or after its commit, optionally stored in a transactional outbox and delivered to durable
 * consumers. Off unless `events: {}` (or `QS_EVENTS_ENABLED=true`) is set.
 */
const eventsFeature = defineFeature({
  key: "events",
  docs: { summary: "Write events for every entity, delivered to listeners inside the write's transaction or after its commit." },
  options,
  // The outbox and delivery rows are system entities, part of the model only while the outbox is on.
  entities: ({ options }) => (options.outbox.enabled ? [outboxEventEntity(), outboxDeliveryEntity()] : []),
  tags: {
    events: {
      on: ["entity"],
      options: ["outbox"],
      description: "`@events off` stops every event of the entity, so its writes keep their plain statements; `@events outbox=false` keeps its events out of the outbox.",
      example: "/** @events off */\nexport type Session = { token: string };",
    },
  },
  commands: eventCommands,
  middleware: [operationMiddleware],
  folders: {
    events: {
      dir: "events",
      check: (value) => isListenerFile(value) || "must default-export listen(...)",
      description: "Listener files: each default-exports listen(pattern, listener, options?), registered without other code.",
    },
  },
  setup(ctx) {
    // A service whose startup failed after this setup never ran its onStop; undo what it left before starting again.
    lifecycle.teardown?.();
    startBus({ logger: ctx.logger, ...(ctx.options.bus ? { bus: ctx.options.bus } : {}), beforeEmit: ctx.options.beforeEmit, afterEmit: ctx.options.afterEmit });
    enableOperationContext();
    // Listener files register first, in file name order, so they run before listeners other features add.
    let repos: ListenerContext["repos"] | undefined;
    ctx.app.onStart((start) => {
      repos = start.repos;
    });
    for (const [name, file] of ctx.folders.events ?? []) {
      if (!isListenerFile(file)) continue;
      const log = { info: (entry: object) => ctx.logger.info({ ...entry, listener: name }), warn: (entry: object) => ctx.logger.warn({ ...entry, listener: name }), error: (entry: object) => ctx.logger.error({ ...entry, listener: name }) } as ListenerContext["log"];
      const listener: EventListener = (event) => file.listener(event as never, { repos: repos!, log });
      events.on(file.pattern, listener as never, file.options);
    }
    // `@events off` leaves an entity unobserved; `@events outbox=false` keeps its events in process.
    const tagged = new WeakMap<EntityModel, { observed: boolean; outbox: boolean }>();
    const settingsOf = (entity: EntityModel) => {
      let found = tagged.get(entity);
      if (!found) {
        let target: ReturnType<typeof eventsFeature.optionsFor>;
        try {
          target = eventsFeature.optionsFor(entity);
        } catch {
          // The current configuration no longer enables the feature (a service that failed to start left this one).
          return { observed: false, outbox: false };
        }
        found = { observed: target.on !== false, outbox: target.outbox.enabled !== false };
        tagged.set(entity, found);
      }
      return found;
    };
    // Every event carries `before`, so every observed write reads it inside its transaction.
    const stopObserving = observeWrites({
      entities: (entity) => !entity.system && settingsOf(entity).observed,
      needsBefore: true,
      write: (change) => publish(toEvent(change), settingsOf(change.entity).outbox),
    });
    const stop = () => {
      lifecycle.teardown = undefined;
      stopObserving();
      disableOperationContext();
      clearConsumers();
      stopOutbox();
      stopBus();
    };
    lifecycle.teardown = stop;
    // onStop callbacks run in reverse order, so this one runs last, after the dispatcher drained.
    ctx.app.onStop(stop);
    const outbox = ctx.options.outbox;
    if (outbox.enabled) {
      const model = ctx.models.find((candidate) => candidate.key === "OutboxEvent" && candidate.system);
      const deliveryModel = ctx.models.find((candidate) => candidate.key === "OutboxDelivery" && candidate.system);
      if (!model || !deliveryModel) throw new Error("The outbox needs the OutboxEvent and OutboxDelivery entities; run quickservice build after turning the outbox on");
      const adapter = ctx.config.database;
      startOutbox(adapter, model, outbox.events, deliveryModel);
      const retentionMs = parseDuration(outbox.retention) ?? 7 * 86_400_000;
      let cleanup: ReturnType<typeof setInterval> | undefined;
      const clean = async () => {
        try {
          const count = await cleanOutbox({
            retentionMs,
            now: Date.now(),
            keep: (ids) => undeliveredEvents(adapter, deliveryModel, ids),
            removed: (ids) => removeDeliveries(adapter, deliveryModel, ids),
          });
          safeLog(ctx.logger, "info", { timestamp: new Date().toISOString(), message: "events.outbox.cleanup", count });
        } catch (error) {
          safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "events.outbox.cleanup.failed", error: { message: (error as Error)?.message ?? String(error) } });
        }
      };
      // Every worker dispatches by default; leases keep two workers from delivering the same row at once.
      let dispatcher: Dispatcher | undefined;
      ctx.app.onStart(() => {
        safeLog(ctx.logger, "info", { timestamp: new Date().toISOString(), message: "events.outbox", patterns: outboxPatterns() });
        if (outbox.dispatch) {
          dispatcher = createDispatcher({ adapter, outboxModel: model, deliveryModel, settings: outbox.delivery, logger: ctx.logger });
          dispatcher.start();
        }
        if (!ctx.worker.runsScheduledWork) return;
        void clean();
        cleanup = setInterval(() => void clean(), OUTBOX_CLEANUP_INTERVAL);
      });
      ctx.app.onShutdown(() => dispatcher?.stop());
      ctx.app.onStop(async () => {
        clearInterval(cleanup);
        await dispatcher?.drain(Math.floor((parseDuration(ctx.config.lifecycle.stopTimeout) ?? 10_000) * 0.9));
      });
    }
    const stopTimeout = parseDuration(ctx.config.lifecycle.stopTimeout) ?? 10_000;
    ctx.app.onShutdown(async () => {
      // Within the shutdown limit, so the lifecycle's own timeout never cuts the report short.
      const limit = Math.floor(stopTimeout * 0.9);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        events.idle().then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), limit);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "events.shutdown.pending", count: pendingDeliveries() });
    });
  },
  api: (ctx): EventsApi => ({
    addHook: ctx.addHook as EventsApi["addHook"],
    on: events.on,
    emit: events.emit,
    deliver: events.deliver,
  }),
});

export default eventsFeature;
export { eventsFeature };
export { events, memoryEventBus } from "./bus.ts";
export { listen } from "./listen.ts";
export { addOutboxPatterns, cleanOutbox, readOutbox, tailOutbox } from "./outbox.ts";
export type { EventsApi } from "./api.ts";
export type { EventBus, EventListener, Events, ListenerPhase, ListenOptions, MemoryEventBus } from "./bus.ts";
export type { ConsumerOptions, DeliveryContext, DeliveryStatus } from "./delivery.ts";
export type { ListenerContext, ListenerFile } from "./listen.ts";
export type { OutboxRecord } from "./outbox.ts";
