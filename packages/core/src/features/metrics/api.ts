import type { MetricsQuery, MetricsResult } from "./query.ts";

/** The public API of the `metrics` native, as `ctx.feature("metrics")` returns it. */
export interface MetricsApi {
  /**
   * The usage series of the windows in a range, merged and grouped by the chosen dimensions, with `requests`, `errors`,
   * `clientErrors`, `p50`, `p95`, `p99` and `max` (milliseconds), plus totals.
   */
  query(options?: MetricsQuery): Promise<MetricsResult>;
  /**
   * Registers a usage counter during setup, like `ai.tokens.input`, counted per route, tenant and user in the same
   * windows as requests; throws `Usage metric <name> is registered twice`.
   */
  usage(name: string, options: { unit: string; description: string }): UsageRecorderHandle;
}

/** What `usage` returns: adds values to the counter. */
export interface UsageRecorderHandle {
  /** Adds a finite value of zero or more; inside a request the dimensions default to its route, tenant and user. */
  add(value: number, dimensions?: { route?: string; tenant?: string; user?: string }): void;
}
