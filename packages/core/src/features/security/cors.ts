import { HttpError, parseDuration, Router } from "../public.ts";
import { EXEMPT } from "./exempt.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";
import type { RouteIndex, SecurityRoute } from "./routes.ts";

/** The `cors` item's options, globally or for one route. */
export interface CorsOptions {
  enabled: boolean;
  origins: readonly string[];
  methods: readonly string[];
  headers: readonly string[];
  exposeHeaders: readonly string[];
  credentials: boolean;
  maxAge: string;
}

/** An entry of `origins`: `*`, `null`, or an origin with an optional `*.` subdomain pattern. */
const ORIGIN_ENTRY = /^[a-z][a-z0-9+.-]*:\/\/(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(:\d{1,5})?$/i;

/** The configuration problems of CORS options, one line each, under `path` (like `security.cors`). */
export function corsProblems(options: Pick<CorsOptions, "origins" | "credentials">, path: string): string[] {
  const problems: string[] = [];
  if (!Array.isArray(options.origins)) return problems;
  options.origins.forEach((entry, index) => {
    if (entry !== "*" && entry !== "null" && !ORIGIN_ENTRY.test(entry)) problems.push(`Invalid ${path}.origins[${index}]: expected an origin like https://app.example.com`);
  });
  if (options.credentials && options.origins.includes("*")) problems.push(`Invalid ${path}: credentials cannot be used with origins "*"`);
  return problems;
}

/**
 * Decides which origins are allowed: exact origins (scheme, host and port), `*` for any, `https://*.example.com` for
 * one or more subdomain labels with the same scheme, and `null` only when listed.
 */
export class OriginMatcher {
  private readonly any: boolean;
  private readonly exact: Set<string>;
  private readonly patterns: { scheme: string; suffix: string }[];

  constructor(origins: readonly string[]) {
    this.any = origins.includes("*");
    this.exact = new Set(origins.filter((entry) => entry !== "*" && !entry.includes("://*.")).map((entry) => entry.toLowerCase()));
    this.patterns = origins
      .filter((entry) => entry.includes("://*."))
      .map((entry) => {
        const [scheme, rest] = entry.toLowerCase().split("://*.") as [string, string];
        return { scheme: `${scheme}://`, suffix: `.${rest}` };
      });
  }

  allows(origin: string): boolean {
    if (origin === "null") return this.exact.has("null");
    if (this.any) return true;
    const lower = origin.toLowerCase();
    if (this.exact.has(lower)) return true;
    for (const { scheme, suffix } of this.patterns) {
      if (!lower.startsWith(scheme) || !lower.endsWith(suffix)) continue;
      const labels = lower.slice(scheme.length, lower.length - suffix.length);
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(labels)) return true;
    }
    return false;
  }
}

/** One option set, ready for requests: its matcher and header values computed once. */
interface CorsPolicy {
  matcher: OriginMatcher;
  methods: Set<string>;
  headers: Set<string>;
  allowMethods: string;
  allowHeaders: string;
  exposeHeaders: string;
  maxAge: string;
  credentials: boolean;
}

function policyOf(options: CorsOptions): CorsPolicy | undefined {
  if (!options.enabled) return undefined;
  return {
    matcher: new OriginMatcher(options.origins),
    methods: new Set(options.methods.map((method) => method.toUpperCase())),
    headers: new Set(options.headers.map((header) => header.toLowerCase())),
    allowMethods: options.methods.map((method) => method.toUpperCase()).join(", "),
    allowHeaders: options.headers.map((header) => header.toLowerCase()).join(", "),
    exposeHeaders: options.exposeHeaders.join(", "),
    maxAge: String(Math.floor((parseDuration(options.maxAge) ?? 0) / 1000)),
    credentials: options.credentials,
  };
}

/** The options a route's `@cors` tag gives: its own values over the global ones, or none with `@cors off`. */
export function routeCorsOptions(global: CorsOptions, route: SecurityRoute): CorsOptions {
  const tag = route.tags.cors;
  if (!tag) return global;
  if (!tag.on) return { ...global, enabled: false };
  return { ...global, ...(tag.options as Partial<CorsOptions>), enabled: true };
}

function appendVary(headers: Headers, value: string): void {
  const vary = headers.get("vary");
  if (vary === null) headers.set("vary", value);
  else if (!vary.split(",").some((entry) => entry.trim().toLowerCase() === value.toLowerCase())) headers.set("vary", `${vary}, ${value}`);
}

/** Sets headers on a response, copying it first when its headers are immutable. */
function withHeaders(response: Response, set: (headers: Headers) => void): Response {
  try {
    set(response.headers);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    set(copy.headers);
    return copy;
  }
}

const ALLOWED = "cors.allowed";

/**
 * The step of the `cors` item: answers preflights before routing (unless the path has an `OPTIONS` endpoint of its
 * own) and adds the CORS headers to the responses of allowed origins.
 */
export function corsStep(options: CorsOptions, ownOptions: Router<true> | undefined, index: () => RouteIndex | undefined): SecurityStep {
  const global = policyOf(options);
  const ofRoute = (route: SecurityRoute | undefined): CorsPolicy | undefined => {
    if (!route?.tags.cors) return global;
    if (!route.cache.has("cors")) route.cache.set("cors", policyOf(routeCorsOptions(options, route)));
    return route.cache.get("cors") as CorsPolicy | undefined;
  };
  return {
    name: "cors",
    before(state: SecurityState) {
      const { request, url } = state.ctx;
      const origin = request.headers.get("origin");
      if (origin === null || state.exempt & EXEMPT.cors) return;
      const requested = request.method === "OPTIONS" ? request.headers.get("access-control-request-method") : null;
      if (requested !== null) {
        // A path with an OPTIONS endpoint of its own answers its preflights itself.
        if (ownOptions?.match("OPTIONS", url.pathname).kind === "found") return;
        const policy = ofRoute(index()?.find(requested.toUpperCase(), url.pathname));
        if (!policy) return;
        if (!policy.matcher.allows(origin)) throw new HttpError(403, "Origin not allowed");
        if (!policy.methods.has(requested.toUpperCase())) throw new HttpError(403, "Method not allowed by CORS");
        for (const name of (request.headers.get("access-control-request-headers") ?? "").split(",")) {
          const header = name.trim().toLowerCase();
          if (header !== "" && !policy.headers.has(header)) throw new HttpError(403, `Header not allowed by CORS: ${header}`);
        }
        const headers = new Headers({
          "access-control-allow-origin": origin,
          "access-control-allow-methods": policy.allowMethods,
          "access-control-allow-headers": policy.allowHeaders,
          "access-control-max-age": policy.maxAge,
          vary: "Origin",
        });
        if (policy.credentials) headers.set("access-control-allow-credentials", "true");
        return new Response(null, { status: 204, headers });
      }
      const policy = ofRoute(state.route);
      if (policy?.matcher.allows(origin)) (state.values ??= {})[ALLOWED] = { origin, policy };
    },
    after(response: Response, state: SecurityState) {
      const allowed = state.values?.[ALLOWED] as { origin: string; policy: CorsPolicy } | undefined;
      if (!allowed) return response;
      return withHeaders(response, (headers) => {
        headers.set("access-control-allow-origin", allowed.origin);
        if (allowed.policy.exposeHeaders !== "") headers.set("access-control-expose-headers", allowed.policy.exposeHeaders);
        if (allowed.policy.credentials) headers.set("access-control-allow-credentials", "true");
        appendVary(headers, "Origin");
      });
    },
  };
}

/** The router of the app's own `OPTIONS` routes, or undefined when it has none. */
export function ownOptionsRoutes(routes: readonly { method: string; path: string }[]): Router<true> | undefined {
  const own = routes.filter((route) => route.method.toUpperCase() === "OPTIONS");
  return own.length === 0 ? undefined : new Router(own.map((route) => ({ method: "OPTIONS", path: route.path, value: true as const })));
}
