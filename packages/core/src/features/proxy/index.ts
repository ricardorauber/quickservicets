import { boolean, cidr, defineFeature, duration, hook, HttpError, list, noteRequestLog, object, oneOf, parseDuration, provider, rate, record, requireRole, requireUser, resolveOption, secret, serviceUrl, size, string, url, type FeatureHook, type OptionFunction, type SecurityRouteOptions, type ServiceRequest } from "../public.ts";
import { forwardRequest, routeWith, templatePath, type ForwardContext, type ForwardOptions, type ProxyDone, type ProxyFailure, type ProxyForwarder, type ProxyOverrides, type ProxyRoute, type ProxyStep } from "./forward.ts";

export type { ForwardOptions, ProxyDone, ProxyFailure, ProxyForwarder, ProxyOverrides, ProxyStep } from "./forward.ts";
import { IDENTITY_HEADER } from "./identity.ts";

export { proxyIdentity, signIdentity, IDENTITY_HEADER } from "./identity.ts";
export type { ProxyIdentityOptions } from "./identity.ts";

/** The methods a route forwards when it lists none. */
export const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const routeOptions = object({
  path: string().describe("The path the route serves: an exact path, or a prefix ending in /* like /billing/*."),
  target: url()
    .optional()
    .perRequest()
    .describe("The upstream's base URL; set this or service. A function of the request, its user and tenant chooses it per request, among allowedTargets."),
  allowedTargets: list(url()).default([]).describe("The base URLs a target function may choose; any other origin answers 502. Required with a target function."),
  service: string().optional().describe("The http.services entry the route calls, with its headers, authentication, TLS and modifiers; set this or target."),
  methods: list(string()).default(DEFAULT_METHODS).describe("The methods the route forwards."),
  timeout: duration().default("30s").describe("How long the upstream may take to send its response headers; longer answers 504."),
  idleTimeout: duration().default("60s").describe("How long the upstream may pause between body chunks."),
  preserveHost: boolean().default(false).describe("Sends the client's host header to the upstream instead of the upstream's own."),
  stripPrefix: boolean().default(false).describe("Removes the route's prefix from the upstream path: /billing/invoices goes up as /invoices."),
  rewrite: string().optional().describe("The upstream path as a template, with [...rest] for the rest of the path after the prefix, like /api/v2/[...rest]."),
  auth: oneOf(["inherit", "public", "required"]).default("inherit").describe("Who may use the route: inherit follows auth.required, public allows anyone, required needs a signed-in user."),
  roles: list(string()).default([]).describe("Roles of which the user needs one; answers 403 Not allowed otherwise."),
  scopes: list(string()).default([]).describe("Token scopes the credentials need, all of them; answers 403 Insufficient scope otherwise."),
  forward: list(oneOf(["user", "roles", "tenant", "authorization", "cookie"]))
    .default(["user", "tenant"])
    .describe("What the upstream receives of the request's identity: user as x-user-id, roles as x-user-roles, tenant as x-tenant-id, and the incoming authorization or cookie headers."),
  rateLimit: object({
    limit: rate().describe("The route's own limit, like 100/min, on top of the global one."),
    by: list(oneOf(["ip", "user", "tenant", "route"])).optional().describe("What the route's limit counts by (default the global rateLimit.by)."),
  })
    .optional()
    .describe("A rate limit of the route, like @rateLimit on an endpoint."),
  cors: object({
    origins: list(string()).optional().describe("The browser origins allowed to call the route."),
    credentials: boolean().optional().describe("Allows credentialed requests from those origins."),
    methods: list(string()).optional().describe("The methods preflights allow."),
    headers: list(string()).optional().describe("The request headers preflights allow."),
  })
    .optional()
    .describe("The route's CORS policy, answered by the gateway: preflights never reach the upstream, and the upstream's own CORS headers are removed."),
  ip: object({
    allow: list(cidr()).optional().describe("Addresses served on the route, on top of the global lists."),
    deny: list(cidr()).optional().describe("Addresses refused on the route, on top of the global lists."),
  })
    .optional()
    .describe("Address lists of the route, like @ipAllow and @ipDeny."),
  maxBodySize: size().optional().describe("The largest request body the route streams to the upstream; larger ones answer 413."),
});

const options = object({
  beforeProxy: hook<ProxyStep, undefined>().describe("Runs before each upstream call with the request, the route and the upstream URL and headers; it may return a changed upstream on the same origin, or throw an HttpError to refuse."),
  afterProxy: hook<ProxyDone, undefined>().describe("Runs once the upstream answered, with the request, the route, the status, the headers and the duration."),
  onProxyError: hook<ProxyFailure, undefined>().describe("Runs when an upstream call fails, with the request, the route and the error."),
  forwarder: provider<ProxyForwarder>("ProxyForwarder", ["forward"])
    .optional()
    .describe("Replaces how the gateway calls upstreams; authentication, identity headers, security options and hooks still apply."),
  allowedTargets: list(url()).default([]).describe("The upstream base URLs forward() may call with an inline target; any other origin answers 502."),
  identity: object({
    secret: secret().optional().describe("Signs every proxied request's forwarded identity with HMAC-SHA256, for proxyIdentity() in the upstream."),
    header: string().default(IDENTITY_HEADER).describe("The header carrying the signed identity."),
    maxAge: duration().default("60s").describe("How old a signed identity may be when the upstream checks it."),
  })
    .default({ header: IDENTITY_HEADER, maxAge: "60s" })
    .describe("The signed header that lets upstream services trust the forwarded user, roles and tenant."),
  routes: record(routeOptions)
    .keys(/^[a-z][a-z0-9-]*$/, "a route name starts with a lowercase letter and uses lowercase letters, digits and -")
    .describe("The proxy routes, by name, each forwarding the requests of its path to an upstream URL or a named service."),
});

type RouteOptions = {
  allowedTargets: string[];
  rateLimit?: { limit: string; by?: string[] };
  cors?: { origins?: string[]; credentials?: boolean; methods?: string[]; headers?: string[] };
  ip?: { allow?: string[]; deny?: string[] };
  maxBodySize?: string | number;
  path: string;
  target?: string | OptionFunction<string>;
  service?: string;
  methods: string[];
  timeout: string;
  idleTimeout: string;
  preserveHost: boolean;
  stripPrefix: boolean;
  rewrite?: string;
  auth: "inherit" | "public" | "required";
  roles: string[];
  scopes: string[];
  forward: ("user" | "roles" | "tenant" | "authorization" | "cookie")[];
};

/** The problems of the configured routes: exactly one of target and service, a valid path, one way of rewriting. */
export function routeProblems(routes: Readonly<Record<string, RouteOptions>>, config: Readonly<Record<string, unknown>> = {}, allowedTargets: readonly string[] = []): string[] {
  const problems: string[] = [];
  // forward() calls inline targets through the proxy/forward service, which a route named forward would also declare.
  if (allowedTargets.length > 0 && routes.forward?.target !== undefined && typeof routes.forward.target !== "function") problems.push("Invalid proxy.routes.forward: the name forward is reserved for forward() targets while proxy.allowedTargets is set");
  const authOn = config.auth !== undefined && config.auth !== false && (config.auth as { enabled?: boolean } | undefined)?.enabled !== false;
  for (const [name, route] of Object.entries(routes)) {
    if ((route.target === undefined) === (route.service === undefined)) problems.push(`Invalid proxy.routes.${name}: set target or service`);
    if (route.stripPrefix && route.rewrite !== undefined) problems.push(`Invalid proxy.routes.${name}: use stripPrefix or rewrite, not both`);
    if (typeof route.target === "function" && (route.allowedTargets ?? []).length === 0) problems.push(`Invalid proxy.routes.${name}: a target function needs allowedTargets`);
    if ((route.auth === "required" || (route.roles ?? []).length > 0 || (route.scopes ?? []).length > 0) && !authOn) {
      problems.push(`proxy.routes.${name} checks users, which needs the auth native; add auth: {} to quickservicets.config.ts`);
    }
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

/** The rest of a request's path after a prefix route's prefix (`/invoices` for `/billing/invoices`), or `` for an exact route. */
function restOf(path: string, prefix: string | undefined): string {
  if (prefix === undefined) return "";
  const rest = path.slice(prefix === "/" ? 0 : prefix.length);
  return rest === "" ? "" : rest.startsWith("/") ? rest : `/${rest}`;
}

/** How a route computes the upstream path, built once: nothing (the path unchanged), stripping the prefix or a template. */
function upstreamPathOf(options: RouteOptions): Pick<ProxyRoute, "upstreamPath"> {
  const prefix = prefixOf(options.path);
  if (options.stripPrefix) return { upstreamPath: (req) => restOf(req.path, prefix) || "/" };
  const template = options.rewrite;
  if (template === undefined) return {};
  return { upstreamPath: templatePath(template, (req) => restOf(req.path, prefix)) };
}

/** What `forward()` needs of the running service: the routes by name with their prefixes, and the allowed inline targets. */
interface RunningProxy {
  routes: Map<string, { route: ProxyRoute; rest: (req: ServiceRequest) => string }>;
  context: ForwardContext;
  /** The service of each origin of `allowedTargets`. */
  targets: ReadonlyMap<string, string>;
}

let current: RunningProxy | undefined;

/** The keys `forward()` takes besides `service` and `target`. */
const CALL_KEYS = new Set(["stripPrefix", "rewrite", "path", "timeout", "idleTimeout", "preserveHost", "forward", "headers"]);

function checkKeys(options: object, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError(`forward(): unknown option ${key}; the options are ${[...allowed].join(", ")}`);
}

function checkOverrides(overrides: ProxyOverrides | undefined): void {
  if (overrides === undefined) return;
  if (typeof overrides !== "object" || overrides === null) throw new TypeError("forward(): overrides must be an object");
  checkKeys(overrides, CALL_KEYS);
}

/**
 * Forwards the current request to an upstream with the whole proxy pipeline (streaming, forwarding and identity
 * headers, SSRF trust, timeouts, hooks and the forwarder) and resolves the upstream's `Response` for every status, so
 * the caller can inspect it, read it or return it unchanged. `options` is a configured route's name, whose
 * authentication runs first and whose settings `overrides` change for this call, or an inline object with exactly
 * one of `service` (an `http.services` entry) and `target` (one of `proxy.allowedTargets`). A timeout, a connection
 * failure, a refused target, an open circuit or a full bulkhead rejects with the `HttpError` (504, 502 or 503) a
 * proxy route would answer.
 */
export function forward(req: ServiceRequest, options: string | ForwardOptions, overrides?: ProxyOverrides): Promise<Response> {
  const running = current;
  if (!running) throw new Error("forward() needs proxy: {} in quickservicets.config.ts");
  let route: ProxyRoute;
  let headers: Readonly<Record<string, string>> | undefined;
  if (typeof options === "string") {
    const named = running.routes.get(options);
    if (!named) throw new Error(`Unknown proxy route ${options}`);
    checkOverrides(overrides);
    route = overrides ? routeWith(named.route, overrides, named.rest) : named.route;
    headers = overrides?.headers;
  } else {
    if (typeof options !== "object" || options === null) throw new TypeError("forward(): options must be a route name or an object");
    checkKeys(options, new Set([...CALL_KEYS, "service", "target"]));
    if ((options.service === undefined) === (options.target === undefined)) throw new TypeError("forward(): set service or target");
    const { context } = running;
    const inline: ProxyRoute = {
      name: null,
      path: "",
      service: "",
      timeoutMs: 30_000,
      idleTimeoutMs: 60_000,
      preserveHost: false,
      forward: new Set(["user", "tenant"]),
      identityHeader: context.identityHeader,
      ...(context.identity ? { identity: context.identity } : {}),
    };
    if (options.service !== undefined) {
      // Throws Unknown service <name> for a name http.services does not declare.
      serviceUrl(options.service);
      inline.service = options.service;
    } else {
      const target = options.target!;
      inline.service = "proxy/forward";
      inline.pickTarget = () => Promise.resolve(target);
      inline.allowed = running.targets;
    }
    checkOverrides(overrides);
    // A path rule of the overrides replaces the options' one.
    const ruled = overrides !== undefined && (overrides.path !== undefined || overrides.stripPrefix !== undefined || overrides.rewrite !== undefined);
    const base: ProxyOverrides = ruled ? { ...options, path: undefined, stripPrefix: undefined, rewrite: undefined } : options;
    route = routeWith(inline, { ...base, ...overrides });
    headers = options.headers || overrides?.headers ? { ...options.headers, ...overrides?.headers } : undefined;
  }
  // Sending an empty body in place of one the handler already read would corrupt the upstream call.
  if (req.raw.bodyUsed) throw new Error("forward(): the request body was already read");
  noteRequestLog(req.raw, { proxy: route.name ?? "forward" });
  return forwardRequest(req, route, running.context, headers);
}

/** `forward(req, routeName, overrides)` under its first name: forwards a request with a configured route's settings. */
export function proxyRequest(req: ServiceRequest, routeName: string, overrides?: ProxyOverrides): Promise<Response> {
  return forward(req, routeName, overrides);
}

/** The security route options of a proxy route, or undefined when it has none, so it adds no route index entry. */
function securityOptionsOf(options: RouteOptions): SecurityRouteOptions | undefined {
  const security: SecurityRouteOptions = {
    ...(options.rateLimit ? { rateLimit: { limit: options.rateLimit.limit, ...(options.rateLimit.by ? { by: options.rateLimit.by } : {}) } } : {}),
    ...(options.cors ? { cors: options.cors } : {}),
    ...(options.ip ? { ip: options.ip } : {}),
    ...(options.maxBodySize !== undefined ? { limits: { body: options.maxBodySize } } : {}),
  };
  return Object.keys(security).length > 0 ? security : undefined;
}

/** The 403 of credentials without a required scope. */
const insufficientScope = (scopes: readonly string[]) =>
  new HttpError(403, "Insufficient scope", { headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="${scopes.join(" ")}"` } });

/** The user checks of a route, built once: none for inherit and public routes without roles or scopes. */
function authorizerOf(options: RouteOptions): Pick<ProxyRoute, "authorize"> {
  const roles = options.roles ?? [];
  const scopes = options.scopes ?? [];
  if (options.auth !== "required" && roles.length === 0 && scopes.length === 0) return {};
  return {
    authorize(req) {
      if (roles.length > 0) requireRole(req, ...roles);
      else requireUser(req);
      if (scopes.length > 0) {
        const granted = req.auth?.scopes ?? [];
        if (!scopes.every((scope) => granted.includes(scope))) throw insufficientScope(scopes);
      }
    },
  };
}

/**
 * The `proxy` native: the service acts as an API gateway, forwarding the requests of configured path prefixes to an
 * upstream URL or a named service, streaming both ways. Off unless `proxy: {}` (or `QS_PROXY_ENABLED=true`) is set.
 */
const proxyFeature = defineFeature({
  key: "proxy",
  docs: {
    summary: "Proxy routes: the service forwards the requests of configured paths to an upstream URL or a named service, streaming both ways, with timeouts and proxy headers.",
    sections: [
      {
        title: "Tags",
        text: "The proxy has no JSDoc tags: its routes are configuration, not entity or endpoint files, so per-route settings (authentication, forwarding, rate limits, CORS, address lists and body limits) are route options.",
      },
      {
        title: "Routes and variables",
        text: "Every option of a route has its variable, with the route's name in upper case and hyphens as underscores: `QS_PROXY_ROUTES_<NAME>_TARGET`, `QS_PROXY_ROUTES_<NAME>_TIMEOUT`, `QS_PROXY_ROUTES_<NAME>_STRIP_PREFIX`, `QS_PROXY_ROUTES_<NAME>_RATE_LIMIT_LIMIT`; `QS_PROXY_ROUTES` sets the whole record as JSON. `proxyIdentity({ secret })` verifies the signed identity in services behind the gateway.",
      },
      {
        title: "forward() from code",
        text: "`forward(req, options, overrides?)` from `@quickservicets/core` forwards the current request from any endpoint, hook or feature handler through the whole proxy pipeline (streaming, forwarding and identity headers with the signature, SSRF trust, timeouts, the hooks with `route: null` for inline calls, and the `forwarder`) and resolves the upstream `Response` for every status, so the caller can inspect it, read it or return it unchanged. `options` is a route name, whose `auth`, `roles` and `scopes` are checked first, or an inline object with exactly one of `service` (an `http.services` entry) and `target` (an origin of `proxy.allowedTargets`, any other answers 502 and logs `proxy.target.refused`), plus `path`, `stripPrefix` or `rewrite` (only one), `timeout`, `idleTimeout`, `preserveHost`, `forward` and `headers` (never hop-by-hop or identity headers); `overrides` takes the same keys except `service` and `target`. A timeout, a connection failure, an open circuit or a full bulkhead rejects with the `HttpError` (504, 502 or 503) a proxy route would answer. `proxy: {}` without routes is enough, `QS_PROXY_ALLOWED_TARGETS` takes the allowed targets comma-separated, each call writes an `http.call` entry (service `proxy/forward` for an inline target) and the request log adds `proxy: <route>` or `proxy: \"forward\"`. `proxyRequest(req, routeName, overrides)` is an alias of `forward(req, routeName, overrides)`.",
      },
    ],
  },
  options,
  requires: [{ name: "http", hint: "proxy routes call their upstreams through the HTTP client" }],
  validate: (resolved, config) => routeProblems(resolved.routes as Record<string, RouteOptions>, config, resolved.allowedTargets as string[]),
  // Route authentication reads req.user, which the auth native sets in the handler stage; route options go to security.
  after: ["auth", "security"],
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
    const hooks = ctx.options as unknown as { beforeProxy: FeatureHook<ProxyStep, undefined>[]; afterProxy: FeatureHook<ProxyDone, undefined>[]; onProxyError: FeatureHook<ProxyFailure, undefined>[] };
    const identitySecret = (ctx.options.identity as { secret?: string }).secret;
    const identity = identitySecret ? { secret: identitySecret, header: ctx.options.identity.header.toLowerCase() } : undefined;
    const context: ForwardContext = {
      identityHeader: ctx.options.identity.header.toLowerCase(),
      ...(identity ? { identity } : {}),
      production: ctx.config.production,
      logger: ctx.logger,
      beforeProxy: hooks.beforeProxy,
      afterProxy: hooks.afterProxy,
      onProxyError: hooks.onProxyError,
      ...(ctx.options.forwarder ? { forwarder: ctx.options.forwarder as ProxyForwarder } : {}),
    };
    // forward() calls an inline target through the proxy/forward service, which SSRF protection trusts for every
    // origin of allowedTargets.
    const targets = new Map<string, string>();
    for (const target of ctx.options.allowedTargets as string[]) {
      const origin = new URL(target).origin;
      if (targets.size === 0) http.addService("forward", { url: origin });
      targets.set(origin, "proxy/forward");
    }
    const running: RunningProxy = { routes: new Map(), context, targets };
    current = running;
    ctx.app.onStop(() => {
      if (current === running) current = undefined;
    });
    for (const [name, options] of routes) {
      // A target becomes a service of its own, so SSRF protection trusts its host like any configured service; so does
      // each allowed target of a target function.
      const chosen = typeof options.target === "function" ? (options.target as OptionFunction<string>) : undefined;
      const allowed = new Map<string, string>();
      if (chosen) {
        options.allowedTargets.forEach((target, index) => {
          const origin = new URL(target).origin;
          if (allowed.has(origin)) return;
          http.addService(`${name}-${index + 1}`, { url: origin });
          allowed.set(origin, `proxy/${name}-${index + 1}`);
        });
      } else if (options.target !== undefined) http.addService(name, { url: options.target as string });
      const route: ProxyRoute = {
        name,
        path: options.path,
        service: options.target !== undefined ? `proxy/${name}` : options.service!,
        ...(chosen ? { pickTarget: (req: ServiceRequest) => Promise.resolve(resolveOption(chosen, { req, user: req.user, tenant: req.tenant } as never)) as Promise<string | undefined>, allowed } : {}),
        timeoutMs: parseDuration(options.timeout) ?? 30_000,
        idleTimeoutMs: parseDuration(options.idleTimeout) ?? 60_000,
        preserveHost: options.preserveHost,
        forward: new Set(options.forward),
        identityHeader: ctx.options.identity.header.toLowerCase(),
        ...(identity ? { identity } : {}),
        ...upstreamPathOf(options),
        ...(options.cors ? { cors: true } : {}),
        ...authorizerOf(options),
      };
      const prefix = prefixOf(options.path);
      running.routes.set(name, { route, rest: (req) => restOf(req.path, prefix) });
      const handler = (_repos: unknown, req: ServiceRequest) => forwardRequest(req, route, context);
      const routeAuth = options.auth === "public" ? { auth: false } : {};
      // Per-route security goes through the security native, like the tags of an endpoint would.
      const security = securityOptionsOf(options);
      if (security) {
        if (!ctx.config.features.some((feature) => feature.key === "security")) throw new Error(`proxy.routes.${name} has security options, which need the security native`);
        ctx.feature("security").routeOptions(options.path, security);
      }
      for (const method of new Set(options.methods.map((method) => method.toUpperCase()))) ctx.app.route(method, routerPath(options.path), handler as never, routeAuth);
    }
  },
});

export default proxyFeature;
export { proxyFeature };
