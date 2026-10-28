import type { MetricsQuery, MetricsResult } from "./query.ts";

/** The public API of the `metrics` native, as `ctx.feature("metrics")` returns it. */
export interface MetricsApi {
  /**
   * The usage series of the windows in a range, merged and grouped by the chosen dimensions, with `requests`, `errors`,
   * `clientErrors`, `p50`, `p95`, `p99` and `max` (milliseconds), plus totals.
   */
  query(options?: MetricsQuery): Promise<MetricsResult>;
}
