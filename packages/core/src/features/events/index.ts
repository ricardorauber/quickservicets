import {
  defineFeature,
  disableOperationContext,
  enableOperationContext,
  observeWrites,
  operationMiddleware,
  parseDuration,
  registerNative,
  safeLog,
} from "../public.ts";
import { events, pendingDeliveries, publish, startBus, stopBus, toEvent } from "./bus.ts";

/**
 * The `events` native: every write of a non-system entity becomes a `WriteEvent`, delivered to listeners inside the
 * write's transaction or after its commit. Off unless `events: {}` (or `QS_EVENTS_ENABLED=true`) is set.
 */
export const eventsFeature = defineFeature({
  key: "events",
  docs: { summary: "Write events for every entity, delivered to listeners inside the write's transaction or after its commit." },
  middleware: [operationMiddleware],
  setup(ctx) {
    startBus({ logger: ctx.logger });
    enableOperationContext();
    // Every event carries `before`, so every observed write reads it inside its transaction.
    const stopObserving = observeWrites({
      entities: (entity) => !entity.system,
      needsBefore: true,
      write: (change) => publish(toEvent(change)),
    });
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
export type { EventActor, EventListener, Events, ListenerPhase, ListenOptions, WriteEvent } from "./bus.ts";
