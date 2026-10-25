import {
  defineFeature,
  duration,
  list,
  object,
  string,
  toggle,
  disableOperationContext,
  enableOperationContext,
  observeWrites,
  operationMiddleware,
  parseDuration,
  registerNative,
  safeLog,
} from "../public.ts";
import { events, pendingDeliveries, publish, startBus, stopBus, toEvent, type EventListener } from "./bus.ts";
import { isListenerFile, type ListenerContext } from "./listen.ts";
import { cleanOutbox, outboxEventEntity, outboxPatterns, startOutbox, stopOutbox } from "./outbox.ts";

/** How often every worker that runs scheduled work deletes outbox rows past their retention. */
export const OUTBOX_CLEANUP_INTERVAL = 3_600_000;

/**
 * The `events` native: every write of a non-system entity becomes a `WriteEvent`, delivered to listeners inside the
 * write's transaction or after its commit. Off unless `events: {}` (or `QS_EVENTS_ENABLED=true`) is set.
 */
export const eventsFeature = defineFeature({
  key: "events",
  docs: { summary: "Write events for every entity, delivered to listeners inside the write's transaction or after its commit." },
  options: object({
    outbox: toggle({
      events: list(string()).default(["*"]).describe("The event patterns stored in the outbox."),
      retention: duration().default("7d").describe("How long outbox rows are kept."),
    })
      .default(false)
      .describe("Stores the chosen events in the write's transaction, so any worker or replica reads every committed event."),
  }),
  // The outbox rows are a system entity, part of the model only while the outbox is on.
  entities: ({ options }) => (options.outbox.enabled ? [outboxEventEntity()] : []),
  middleware: [operationMiddleware],
  folders: {
    events: {
      dir: "events",
      check: (value) => isListenerFile(value) || "must default-export listen(...)",
      description: "Listener files: each default-exports listen(pattern, listener, options?), registered without other code.",
    },
  },
  setup(ctx) {
    startBus({ logger: ctx.logger });
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
    // Every event carries `before`, so every observed write reads it inside its transaction.
    const stopObserving = observeWrites({
      entities: (entity) => !entity.system,
      needsBefore: true,
      write: (change) => publish(toEvent(change)),
    });
    const outbox = ctx.options.outbox;
    if (outbox.enabled) {
      const model = ctx.models.find((candidate) => candidate.key === "OutboxEvent" && candidate.system);
      if (!model) throw new Error("The outbox needs the OutboxEvent entity; run quickservice build after turning the outbox on");
      startOutbox(ctx.config.database, model, outbox.events);
      const retentionMs = parseDuration(outbox.retention) ?? 7 * 86_400_000;
      let cleanup: ReturnType<typeof setInterval> | undefined;
      const clean = async () => {
        try {
          const count = await cleanOutbox({ retentionMs, now: Date.now() });
          safeLog(ctx.logger, "info", { timestamp: new Date().toISOString(), message: "events.outbox.cleanup", count });
        } catch (error) {
          safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "events.outbox.cleanup.failed", error: { message: (error as Error)?.message ?? String(error) } });
        }
      };
      ctx.app.onStart(() => {
        safeLog(ctx.logger, "info", { timestamp: new Date().toISOString(), message: "events.outbox", patterns: outboxPatterns() });
        if (!ctx.worker.runsScheduledWork) return;
        void clean();
        cleanup = setInterval(() => void clean(), OUTBOX_CLEANUP_INTERVAL);
      });
      ctx.app.onStop(() => {
        clearInterval(cleanup);
        stopOutbox();
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
    ctx.app.onStop(() => {
      stopObserving();
      disableOperationContext();
      stopBus();
    });
  },
});

registerNative(eventsFeature);

export { events } from "./bus.ts";
export { listen } from "./listen.ts";
export { addOutboxPatterns, cleanOutbox, readOutbox, tailOutbox } from "./outbox.ts";
export type { OutboxRecord } from "./outbox.ts";
export type { EventListener, Events, ListenerPhase, ListenOptions } from "./bus.ts";
export type { ListenerContext, ListenerFile } from "./listen.ts";
