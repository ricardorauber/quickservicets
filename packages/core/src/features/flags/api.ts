import type { FeatureHook, ServiceRequest } from "../public.ts";
import type { FlagEvaluation } from "./index.ts";

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

/** What a flag provider gets for each evaluation: the user, the tenant and the request (undefined outside requests). */
export interface FlagProviderContext {
  user: unknown;
  tenant: unknown;
  req: ServiceRequest | undefined;
}

/**
 * Replaces the evaluation of the config and database sources, like a client of Unleash or OpenFeature
 * (`flags: { provider }` or `setProvider`); answers synchronously, from its own cache.
 */
export interface FlagProvider {
  isOn(name: string, ctx: FlagProviderContext): boolean;
  all(ctx: FlagProviderContext): Record<string, boolean>;
  /** Runs when the server starts, like opening the provider's connection. */
  start?(): void | Promise<void>;
  /** Runs when the server stops. */
  stop?(): void | Promise<void>;
}

/** The feature API of `flags`, reached with `ctx.feature("flags")` from a feature that lists `flags` in `requires` or `after`. */
export interface FlagsApi {
  /** Whether a flag is on for a user and a tenant, with the same rules as `req.flags`. */
  isOn(name: string, context?: FlagContext): boolean;
  /** Every known flag with its value for a user and a tenant. */
  all(context?: FlagContext): Record<string, boolean>;
  /** Appends an `onEvaluate` hook after the config's; it observes each new evaluation. */
  onEvaluate(fn: FeatureHook<FlagEvaluation, undefined>): void;
  /** Replaces the evaluation with a provider, during setup; a second provider fails startup. */
  setProvider(provider: FlagProvider): void;
}
