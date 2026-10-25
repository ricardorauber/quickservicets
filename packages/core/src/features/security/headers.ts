import { DOCS_PATH, parseDuration } from "../public.ts";
import { EXEMPT } from "./exempt.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";
import type { SecurityRoute } from "./routes.ts";

/** The API policy: a JSON response never needs to load anything, and no page may frame it. */
export const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'";

/** The policy of `GET /docs`, which loads the pinned Scalar script and fonts and reads `/openapi.json`. */
export const DEFAULT_DOCS_CSP =
  "default-src 'none'; script-src https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.scalar.com; font-src https://cdn.jsdelivr.net https://fonts.scalar.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** The `headers` item's options. */
export interface HeadersOptions {
  enabled: boolean;
  contentTypeOptions: boolean;
  referrerPolicy: string;
  frameOptions: string;
  csp: string;
  docsCsp: string;
  hsts: { enabled: boolean; maxAge: string; includeSubDomains: boolean; preload: boolean };
}

/** The headers one option set adds, as name and value pairs computed once. */
type HeaderSet = readonly (readonly [string, string])[];

/** The header pairs of an option set; empty strings and switched-off options leave their header out. */
export function headerSet(options: HeadersOptions, production: boolean, csp: string): HeaderSet {
  if (!options.enabled) return [];
  const pairs: [string, string][] = [];
  if (options.contentTypeOptions) pairs.push(["x-content-type-options", "nosniff"]);
  if (options.referrerPolicy !== "") pairs.push(["referrer-policy", options.referrerPolicy]);
  if (options.frameOptions !== "") pairs.push(["x-frame-options", options.frameOptions]);
  if (csp !== "") pairs.push(["content-security-policy", csp]);
  if (production && options.hsts.enabled) {
    const seconds = Math.floor((parseDuration(options.hsts.maxAge) ?? 0) / 1000);
    pairs.push(["strict-transport-security", `max-age=${seconds}${options.hsts.includeSubDomains ? "; includeSubDomains" : ""}${options.hsts.preload ? "; preload" : ""}`]);
  }
  return pairs;
}

/**
 * Adds the pairs a response does not have yet, so headers a handler or hook set win; a response whose headers are
 * immutable is copied first.
 */
export function addHeaders(response: Response, pairs: HeaderSet): Response {
  let target = response;
  for (const [name, value] of pairs) {
    if (target.headers.has(name)) continue;
    try {
      target.headers.set(name, value);
    } catch {
      target = new Response(target.body, target);
      target.headers.set(name, value);
    }
  }
  return target;
}

/** The step of the `headers` item: the precomputed headers of the global options, of `GET /docs` and of tagged routes. */
export function headersStep(options: HeadersOptions, production: boolean): SecurityStep {
  const global = headerSet(options, production, options.csp);
  const docs = headerSet(options, production, options.docsCsp);
  const ofRoute = (route: SecurityRoute): HeaderSet => {
    let pairs = route.cache.get("headers") as HeaderSet | undefined;
    if (pairs) return pairs;
    const tag = route.tags.securityHeaders;
    if (!tag) pairs = global;
    else if (!tag.on) pairs = [];
    else {
      const changed = { ...options, ...(tag.options as Partial<HeadersOptions>) };
      pairs = headerSet(changed, production, changed.csp);
    }
    route.cache.set("headers", pairs);
    return pairs;
  };
  return {
    name: "headers",
    after(response: Response, state: SecurityState) {
      if (state.exempt & EXEMPT.headers) return response;
      const { request, url } = state.ctx;
      const route = state.route;
      const pairs = route ? ofRoute(route) : url.pathname === DOCS_PATH && request.method === "GET" ? docs : global;
      return pairs.length === 0 ? response : addHeaders(response, pairs);
    },
  };
}
