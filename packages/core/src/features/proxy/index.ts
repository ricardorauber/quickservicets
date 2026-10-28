import { boolean, defineFeature, duration, list, object, parseDuration, record, string, url, type ServiceRequest } from "../public.ts";
import { forwardRequest, type ProxyRoute } from "./forward.ts";

/** The methods a route forwards when it lists none. */
export const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const routeOptions = object({
  path: string().describe("The path the route serves: an exact path, or a prefix ending in /* like /billing/*."),
  target: url().optional().describe("The upstream's base URL; set this or service."),
  service: string().optional().describe("The http.services entry the route calls, with its headers, authentication, TLS and modifiers; set this or target."),
  methods: list(string()).default(DEFAULT_METHODS).describe("The methods the route forwards."),
  timeout: duration().default("30s").describe("How long the upstream may take to send its response headers; longer answers 504."),
  idleTimeout: duration().default("60s").describe("How long the upstream may pause between body chunks."),
  preserveHost: boolean().default(false).describe("Sends the client's host header to the upstream instead of the upstream's own."),
});

const options = object({
  routes: record(routeOptions)
    .keys(/^[a-z][a-z0-9-]*$/, "a route name starts with a lowercase letter and uses lowercase letters, digits and -")
    .describe("The proxy routes, by name, each forwarding the requests of its path to an upstream URL or a named service."),
});

type RouteOptions = { path: string; target?: string; service?: string; methods: string[]; timeout: string; idleTimeout: string; preserveHost: boolean };

/** The problems of the configured routes: exactly one of target and service, and a valid path. */
export function routeProblems(routes: Readonly<Record<string, RouteOptions>>): string[] {
  const problems: string[] = [];
  for (const [name, route] of Object.entries(routes)) {
    if ((route.target === undefined) === (route.service === undefined)) problems.push(`Invalid proxy.routes.${name}: set target or service`);
    if (!/^\/[^*]*(\/\*)?$/.test(route.path)) problems.push(`Invalid proxy.routes.${name}.path: expected a path like /billing or a prefix like /billing/*`);
  }
  return problems;
}

/** The prefix of a route path (`/billing` for `/billing/*`), or undefined for an exact path. */
const prefixOf = (path: string) => (path.endsWith("/*") ? path.slice(0, -2) : undefined);

/** Whether two route paths can match the same request path. */
function overlap(a: string, b: string): boolean {
  const covers = (prefix: string | undefined, other: string) => prefix !== undefined && (other === prefix || other.startsWith(`${prefix}/`) || (prefixOf(other) ?? "") === prefix);
  if (a === b) return true;
  return covers(prefixOf(a), prefixOf(b) ?? b) || covers(prefixOf(b), prefixOf(a) ?? a);
}

/** The router path of a route: `/billing/[...rest]` for a prefix, the path itself otherwise. */
const routerPath = (path: string) => {
  const prefix = prefixOf(path);
  return prefix === undefined ? path : `${prefix === "/" ? "" : prefix}/[...rest]`;
};

/**
 * The `proxy` native: the service acts as an API gateway, forwarding the requests of configured path prefixes to an
 * upstream URL or a named service, streaming both ways. Off unless `proxy: {}` (or `QS_PROXY_ENABLED=true`) is set.
 */
const proxyFeature = defineFeature({
  key: "proxy",
  docs: { summary: "Proxy routes: the service forwards the requests of configured paths to an upstream URL or a named service, streaming both ways, with timeouts and proxy headers." },
  options,
  requires: [{ name: "http", hint: "proxy routes call their upstreams through the HTTP client" }],
  validate: (resolved) => routeProblems(resolved.routes as Record<string, RouteOptions>),
  setup(ctx) {
    const routes = Object.entries(ctx.options.routes as Record<string, RouteOptions>);
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const [a, first] = routes[i]!;
        const [b, second] = routes[j]!;
        if (overlap(first.path, second.path)) throw new Error(`Proxy routes ${a} (${first.path}) and ${b} (${second.path}) overlap`);
      }
    }
    const http = ctx.feature("http");
    for (const [name, options] of routes) {
      // A target becomes a service of its own, so SSRF protection trusts its host like any configured service.
      if (options.target !== undefined) http.addService(name, { url: options.target });
      const route: ProxyRoute = {
        name,
        path: options.path,
        service: options.target !== undefined ? `proxy/${name}` : options.service!,
        timeoutMs: parseDuration(options.timeout) ?? 30_000,
        idleTimeoutMs: parseDuration(options.idleTimeout) ?? 60_000,
        preserveHost: options.preserveHost,
      };
      const handler = (_repos: unknown, req: ServiceRequest) => forwardRequest(req, route, ctx.config.production);
      for (const method of new Set(options.methods.map((method) => method.toUpperCase()))) ctx.app.route(method, routerPath(options.path), handler as never);
    }
  },
});

export default proxyFeature;
export { proxyFeature };
