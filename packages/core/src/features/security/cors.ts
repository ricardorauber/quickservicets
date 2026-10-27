import { HttpError, OriginMatcher, parseDuration, resolveOption, Router, type OptionFunction, type ServiceRequest } from "../public.ts";
import { EXEMPT } from "./exempt.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";
import type { RouteIndex, SecurityRoute } from "./routes.ts";

/** The `cors` item's options, globally or for one route. */
export interface CorsOptions {
  enabled: boolean;
  /** The allowed origins, or a function of the request computing them for each request with an `Origin` header. */
  origins: readonly string[] | OptionFunction<string[]>;
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
  // Origins computed per request are matched by the same rules when they are known.
  if (!Array.isArray(options.origins)) return problems;
  options.origins.forEach((entry, index) => {
    if (entry !== "*" && entry !== "null" && !ORIGIN_ENTRY.test(entry)) problems.push(`Invalid ${path}.origins[${index}]: expected an origin like https://app.example.com`);
  });
  if (options.credentials && options.origins.includes("*")) problems.push(`Invalid ${path}: credentials cannot be used with origins "*"`);
  return problems;
}

/** One option set, ready for requests: its matcher and header values computed once. */
interface CorsPolicy {
  /** The matcher of fixed origins, or the function computing them per request. */
  matcher: OriginMatcher | OptionFunction<string[]>;
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
    matcher: typeof options.origins === "function" ? options.origins : new OriginMatcher(options.origins),
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
export function corsStep(options: CorsOptions, ownOptions: Router<true> | undefined, index: () => RouteIndex | undefined, ipOf: (request: Request) => string = () => "unknown"): SecurityStep {
  const global = policyOf(options);
  // Matchers of the origin lists per-request functions return, by list.
  const computed = new Map<string, OriginMatcher>();
  const matcherOf = (origins: readonly string[]) => {
    const key = origins.join("\n");
    let matcher = computed.get(key);
    if (!matcher) {
      matcher = new OriginMatcher(origins);
      if (computed.size < 1000) computed.set(key, matcher);
    }
    return matcher;
  };
  /** What a per-request origins function receives as `req`: the request before routing. */
  const requestView = (state: SecurityState): ServiceRequest => {
    const { request, url } = state.ctx;
    return { method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, raw: request, get ip() { return ipOf(request); } } as unknown as ServiceRequest;
  };
  const allows = (policy: CorsPolicy, origin: string, state: SecurityState): boolean | Promise<boolean> => {
    if (policy.matcher instanceof OriginMatcher) return policy.matcher.allows(origin);
    const origins = resolveOption(policy.matcher, { req: requestView(state) });
    return origins instanceof Promise ? origins.then((list) => matcherOf(list).allows(origin)) : matcherOf(origins).allows(origin);
  };
  const ofRoute = (route: SecurityRoute | undefined): CorsPolicy | undefined => {
    if (!route?.tags.cors) return global;
    if (!route.cache.has("cors")) route.cache.set("cors", policyOf(routeCorsOptions(options, route)));
    return route.cache.get("cors") as CorsPolicy | undefined;
  };
  /** The answer to a preflight whose origin was checked. */
  const preflight = (state: SecurityState, policy: CorsPolicy, origin: string, requested: string, allowed: boolean): Response => {
    const { request } = state.ctx;
    if (!allowed) throw state.refuse("cors", new HttpError(403, "Origin not allowed"));
    if (!policy.methods.has(requested.toUpperCase())) throw state.refuse("cors", new HttpError(403, "Method not allowed by CORS"));
    for (const name of (request.headers.get("access-control-request-headers") ?? "").split(",")) {
      const header = name.trim().toLowerCase();
      if (header !== "" && !policy.headers.has(header)) throw state.refuse("cors", new HttpError(403, `Header not allowed by CORS: ${header}`));
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
        const allowed = allows(policy, origin, state);
        if (allowed instanceof Promise) return allowed.then((settled) => preflight(state, policy, origin, requested, settled));
        return preflight(state, policy, origin, requested, allowed);
      }
      const policy = ofRoute(state.route);
      if (!policy) return;
      const allowed = allows(policy, origin, state);
      const keep = (settled: boolean) => {
        if (settled) (state.values ??= {})[ALLOWED] = { origin, policy };
      };
      if (allowed instanceof Promise) return allowed.then(keep);
      keep(allowed);
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
