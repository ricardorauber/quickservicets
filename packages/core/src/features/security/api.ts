import type { LogMasker } from "../public.ts";
import type { ExemptibleItem } from "./exempt.ts";
import type { RateLimitStore } from "./store.ts";

/** The feature API of `security`, reached with `ctx.feature("security")` from a feature that lists `security` in `requires` or `after`. */
export interface SecurityApi {
  /**
   * Exempts the paths matching `pattern` (a path, or a path ending in `/*` for it and every path below it) from the
   * listed items: `"rateLimit"`, `"loadShedding"`, `"ip"`, `"cors"`, `"headers"` or `"all"`. Only available during setup.
   */
  exempt(pattern: string, items: readonly ExemptibleItem[]): void;
  /**
   * Replaces the rate limit store, like a Redis store of a plugin. Only available during setup; setting it twice, or
   * when the config already sets a store, fails startup naming both owners.
   */
  rateLimitStore(store: RateLimitStore): void;
  /**
   * The masking of `security.masking` (secret values, `@sensitive` fields and secret-looking keys), for features that
   * send values out of the service, like error reports; undefined while masking is off.
   */
  masker(): LogMasker | undefined;
  /**
   * Gives the paths matching `pattern` (a path, or a prefix ending in `/*`) the route options the `@rateLimit`, `@cors`,
   * `@ipAllow`/`@ipDeny` and `@limits` tags would give an endpoint, for routes that have no file to tag, like proxy
   * routes. Only available during setup.
   */
  routeOptions(pattern: string, options: SecurityRouteOptions): void;
  /**
   * Checks the files of `server.tls` and `security.mtls.ca` at once, like `SIGHUP`, applying renewed certificates to
   * new connections; resolves whether a file changed and whether the change was applied.
   */
  reloadTls(): Promise<{ changed: boolean; applied: boolean }>;
  /**
   * The `ip` item at runtime: `reload()` loads `ip.source` now in this worker and resolves the `allow` and `deny`
   * counts once the new lists are in effect, or rejects with the load error; without a source, it resolves the config
   * counts. Available during setup and later through the API object a feature keeps.
   */
  ip: SecurityIpApi;
  /** `routeOptions(pattern, { rateLimit: { limit, by } })`. */
  limit(pattern: string, options: { limit: string | ((ctx: never) => unknown); by?: readonly string[] }): void;
}

/** The `ip` item of the security API. */
export interface SecurityIpApi {
  /** Loads `ip.source` now and resolves the counts in effect, or rejects with the load error. */
  reload(): Promise<{ allow: number; deny: number }>;
}

/** What `routeOptions` gives a path: the shapes of the matching security items. */
export interface SecurityRouteOptions {
  /** A rate limit of the path's own, like `@rateLimit`: `limit` (`10/min`) and optionally `by`. */
  rateLimit?: { limit: string | ((ctx: never) => unknown); by?: readonly string[] };
  /** The CORS options of the path, like `@cors`. */
  cors?: { origins?: readonly string[] | ((ctx: never) => unknown); credentials?: boolean; methods?: readonly string[]; headers?: readonly string[] };
  /** Address lists of the path, like `@ipAllow` and `@ipDeny`. */
  ip?: { allow?: readonly string[]; deny?: readonly string[] };
  /** The body limit of the path, like `@limits body=`. */
  limits?: { body: string | number };
}

/** Computes the client address of a request, replacing the trusted walk of `security.proxy` (`proxy.resolver`). */
export interface ClientIpResolver {
  resolve(input: { request: Request; peer: string }): string;
}

/** What the hooks of a refusal receive. */
export interface SecurityRefusal {
  request: Request;
  /** The client address, as `req.ip` reads it. */
  ip: string;
  /** The matched route, like `GET /posts/[id]`, or undefined for an unknown path. */
  route: string | undefined;
  /** The item that refused the request. */
  item: "rateLimit" | "ip" | "cors" | "loadShedding" | "limits" | "mtls";
  /** The message of the refusal, like `Too many requests`. */
  reason: string;
  /** The caller's client certificate, for refusals of the `mtls` item. */
  client?: { commonName?: string; fingerprint256: string };
}

/** What `rateLimit.onLimited` receives: a refusal with the bucket's key and limit. */
export interface RateLimitRefusal extends SecurityRefusal {
  key: string;
  /** The limit of the bucket, like `10/min`. */
  limit: string;
}
