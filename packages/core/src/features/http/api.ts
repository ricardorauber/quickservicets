import type { HttpModifier } from "./client.ts";
import type { ServiceOptionsInput } from "./options.ts";

/** The feature API of `http`, reached with `ctx.feature("http")` from a feature that lists `http` in `after` or `requires`. */
export interface HttpApi {
  /**
   * Registers a named service during setup, under `<feature key>/<name>` (or the feature key itself when `name` is
   * it), with the options of `http.services`; its host is trusted by SSRF protection for calls through it.
   */
  addService(name: string, options: ServiceOptionsInput): void;
  /**
   * Registers a named modifier during setup, which services list in `modifiers`; a name registered twice fails
   * startup naming both owners.
   */
  modifier(name: string, modifier: HttpModifier): void;
}
