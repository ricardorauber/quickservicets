const STORE = Symbol.for("quickservicets.webhooks.state");

/**
 * Process-wide state of the `webhooks` feature, by name. It lives on `globalThis`, so the native and a copy of it
 * ejected into a project share it, and the core's `webhooks` export reaches whichever of them runs.
 */
export function sharedState<T>(name: string, init: () => T): T {
  const store = ((globalThis as unknown as Record<symbol, Record<string, unknown>>)[STORE] ??= {});
  return (store[name] ??= init()) as T;
}
