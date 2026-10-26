import type { ErrorReporter } from "../public.ts";

/** The feature API of `errors`, reached with `ctx.feature("errors")` from a feature that lists `errors` in `requires` or `after`. */
export interface ErrorsApi {
  /** Adds a reporter that receives every report after the configured ones. */
  addReporter(reporter: ErrorReporter): void;
}
