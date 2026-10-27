const STORE = Symbol.for("quickservicets.http.state");

/**
 * Process-wide state of the `http` feature, by name. It lives on `globalThis`, so the native and a copy of it ejected
 * into a project share it, and the core's `http` reaches whichever of them runs.
 */
export function sharedState<T>(name: string, init: () => T): T {
  const store = ((globalThis as unknown as Record<symbol, Record<string, unknown>>)[STORE] ??= {});
  return (store[name] ??= init()) as T;
}
