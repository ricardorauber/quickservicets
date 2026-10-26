/** Who a flag is read for outside a request: a user and a tenant, each with an id. */
export interface FlagTarget {
  user?: { id?: unknown } | undefined;
  tenant?: { id?: unknown } | undefined;
}

/** `ctx.flags` of jobs and queue consumers: flags read for a user and a tenant given in each call, anonymous without them. */
export interface ContextFlagEvaluator<Name extends string = string> {
  on(name: Name, target?: FlagTarget): boolean;
  off(name: Name, target?: FlagTarget): boolean;
  all(target?: FlagTarget): Record<string, boolean>;
}

const SLOT = Symbol.for("quickservice.flags.context");
const slot = globalThis as unknown as { [SLOT]?: ContextFlagEvaluator };

/** Sets (or removes) the `ctx.flags` jobs and queue consumers receive; the `flags` native sets it while it runs. */
export function setContextFlags(flags: ContextFlagEvaluator | undefined): void {
  slot[SLOT] = flags;
}

/** The `ctx.flags` of the running service, undefined while the `flags` native is off. */
export function contextFlags(): ContextFlagEvaluator | undefined {
  return slot[SLOT];
}
