import { AsyncLocalStorage } from "node:async_hooks";
import { activeSetup } from "./setup-phase.ts";

/** The write causes code may set around its writes: `replay` for tools that rewrite records without side effects. */
export type SetWriteCause = "replay";

const SLOT = Symbol.for("quickservicets.write-cause");
const state = ((globalThis as unknown as Record<symbol, unknown>)[SLOT] ??= { causes: new AsyncLocalStorage<SetWriteCause>(), allowed: new AsyncLocalStorage<true>(), serving: 0 }) as {
  causes: AsyncLocalStorage<SetWriteCause>;
  allowed: AsyncLocalStorage<true>;
  serving: number;
};

/**
 * Runs a CLI command or the start of a service's features as code that may call `withWriteCause`, even while another
 * service of the process serves requests.
 */
export function runAsCommand<T>(fn: () => T): T {
  return state.allowed.run(true, fn);
}

/** Counts a service that started serving requests (`1`) or stopped (`-1`); the lifecycle calls it. */
export function markServing(delta: 1 | -1): void {
  state.serving = Math.max(0, state.serving + delta);
}

/**
 * Runs `fn` with every repository write inside it (cascades and touches included) reported to write observers with
 * `cause` instead of its own, so `replay` writes emit no events, outbox rows or history versions. Only CLI commands
 * and feature setup code may call it: it throws `withWriteCause is not allowed during requests` while a service serves.
 */
export function withWriteCause<T>(cause: SetWriteCause, fn: () => T | Promise<T>): Promise<T> {
  if (cause !== "replay") return Promise.reject(new Error(`Unknown write cause ${String(cause)}; expected replay`));
  if (state.serving > 0 && state.allowed.getStore() !== true && activeSetup() === undefined) return Promise.reject(new Error("withWriteCause is not allowed during requests"));
  return Promise.resolve(state.causes.run(cause, fn));
}

/** The cause `withWriteCause` set around the current code, if any. */
export function currentWriteCause(): SetWriteCause | undefined {
  return state.causes.getStore();
}
