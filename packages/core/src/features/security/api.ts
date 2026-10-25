import type { ExemptibleItem } from "./exempt.ts";

/** The feature API of `security`, reached with `ctx.feature("security")` from a feature that lists `security` in `requires` or `after`. */
export interface SecurityApi {
  /**
   * Exempts the paths matching `pattern` (a path, or a path ending in `/*` for it and every path below it) from the
   * listed items: `"rateLimit"`, `"loadShedding"`, `"ip"`, `"cors"`, `"headers"` or `"all"`. Only available during setup.
   */
  exempt(pattern: string, items: readonly ExemptibleItem[]): void;
}
