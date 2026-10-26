const STORE = Symbol.for("quickservicets.events.state");

/**
 * Process-wide state of the `events` feature, by name. It lives on `globalThis`, so the native and a copy of it ejected
 * into a project share one bus, outbox and set of consumers, and the core's `events`, `listen` and `readOutbox` reach
 * whichever of them runs.
 */
export function sharedState<T>(name: string, init: () => T): T {
  const store = ((globalThis as unknown as Record<symbol, Record<string, unknown>>)[STORE] ??= {});
  return (store[name] ??= init()) as T;
}
