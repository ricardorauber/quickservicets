/** Who a flag is read for outside a request: a user and a tenant, each with an id. */
export interface FlagContext {
  user?: { id?: unknown } | undefined;
  tenant?: { id?: unknown } | undefined;
}

/** `req.flags`: the flags of one request, evaluated for its user and tenant, synchronously. */
export interface RequestFlagEvaluator<Name extends string = string> {
  /** Whether the flag is on for the request; an unknown name is off. */
  on(name: Name): boolean;
  /** Whether the flag is off for the request. */
  off(name: Name): boolean;
  /** Every known flag with its value for the request. */
  all(): Record<string, boolean>;
}

/** The feature API of `flags`, reached with `ctx.feature("flags")` from a feature that lists `flags` in `requires` or `after`. */
export interface FlagsApi {
  /** Whether a flag is on for a user and a tenant, with the same rules as `req.flags`. */
  isOn(name: string, context?: FlagContext): boolean;
  /** Every known flag with its value for a user and a tenant. */
  all(context?: FlagContext): Record<string, boolean>;
}
