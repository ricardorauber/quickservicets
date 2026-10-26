import type { ErrorReport, ErrorReporter, FeatureHook } from "../public.ts";

/** The feature API of `errors`, reached with `ctx.feature("errors")` from a feature that lists `errors` in `requires` or `after`. */
export interface ErrorsApi {
  /** Adds a reporter that receives every report after the configured ones. */
  addReporter(reporter: ErrorReporter): void;
  /** Appends a `beforeReport` hook after the config's; it returns a changed report, or null to drop it. */
  beforeReport(fn: FeatureHook<ErrorReport | null, undefined>): void;
}
