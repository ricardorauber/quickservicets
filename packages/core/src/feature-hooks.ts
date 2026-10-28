import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import type { FeatureHook } from "./options.ts";
import { startSpan, tracingEnabled, withSpan } from "./tracing.ts";

/** Where a resolved list of hooks came from: the option's path, like `audit.beforeWrite`. */
export const HOOK_PATH = Symbol.for("quickservicets.hook.path");

type HookList<V, C> = readonly FeatureHook<V, C>[] & { [HOOK_PATH]?: string };

let hookLogger: Logger = jsonLogger;

/** Sets the logger after-hook failures go to: the configured logger of the last resolved configuration. */
export function setHookLogger(logger: Logger | undefined): void {
  hookLogger = logger ?? jsonLogger;
}

/**
 * Runs before-hooks in order with `(value, ctx)`: each may return a changed value, passed on to the next, or undefined
 * to keep the current one. Resolves to the final value, and rejects with the error of a throwing hook, so the step it
 * guards is cancelled and later hooks do not run.
 */
export async function runBeforeHooks<V, C>(list: readonly FeatureHook<V, C>[], value: V, ctx: C): Promise<V> {
  let current = value;
  for (const hook of list) {
    const input = current;
    const result = tracingEnabled() ? await tracedFeatureHook(list, () => hook(input, ctx)) : await hook(current, ctx);
    if (result !== undefined) current = result as V;
  }
  return current;
}

/** Runs one feature hook in an internal span named after its option (`<feature>.<hook>`), recording a thrown error. */
async function tracedFeatureHook<T>(list: readonly unknown[], run: () => T | Promise<T>): Promise<T> {
  const name = (list as { [HOOK_PATH]?: string })[HOOK_PATH] ?? "feature";
  const span = startSpan(`hook ${name}`, { kind: "internal" });
  try {
    return await withSpan(span, run);
  } catch (error) {
    span.recordException(error);
    span.setStatus("error");
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Runs after-hooks in order with `(value, ctx)`, awaiting each; a failing hook is logged as `feature.hook.failed` with
 * the feature, the hook and the error, and the next hook still runs. Never rejects.
 */
export async function runAfterHooks<V, C>(list: readonly FeatureHook<V, C>[], value: V, ctx: C): Promise<void> {
  for (const hook of list) {
    try {
      if (tracingEnabled()) await tracedFeatureHook(list, () => hook(value, ctx));
      else await hook(value, ctx);
    } catch (error) {
      const path = (list as HookList<V, C>)[HOOK_PATH] ?? "";
      const [feature, ...rest] = path.split(".");
      safeLog(hookLogger, "error", {
        timestamp: new Date().toISOString(),
        message: "feature.hook.failed",
        feature,
        hook: rest.join("."),
        error: { message: (error as Error)?.message ?? String(error), ...(error instanceof Error ? { stack: error.stack } : {}) },
      });
    }
  }
}

/** The names hook options may have: `before<Step>`, `after<Step>` or `on<Event>`. */
export const HOOK_NAME = /^(before|after|on)[A-Z][A-Za-z0-9]*$/;
