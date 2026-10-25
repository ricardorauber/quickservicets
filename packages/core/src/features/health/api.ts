/** What a check receives: a signal aborted when the check's timeout passes. */
export interface HealthCheckInput {
  signal: AbortSignal;
}

/** A check: resolves when healthy (optionally with extra fields for its entry), throws when not. */
export type HealthCheckFunction = (input: HealthCheckInput, ctx?: undefined) => unknown | Promise<unknown>;

/** Options of a check a feature registers. */
export interface HealthCheckOptions {
  /** The check's time limit, as a duration like `1s` (default `health.timeout`). */
  timeout?: string;
  /** Whether a failure fails readiness (503) rather than degrading it (default true). */
  critical?: boolean;
}

/** The feature API of `health`, reached with `ctx.feature("health")` from a feature that lists `health` in `requires` or `after`. */
export interface HealthApi {
  /**
   * Adds a readiness check named `<key>.<name>` after the calling feature's key, from its setup only; startup fails
   * with `Health check <name> is defined by <owner> and <owner>` when the name is taken.
   */
  check(name: string, fn: (input: HealthCheckInput) => unknown | Promise<unknown>, options?: HealthCheckOptions): void;
}
