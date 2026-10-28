import { coreInstruments, metricsEnabled, anyOf, hook, normalizeAddress, provider, runAfterHooks, secretVariableValues, boolean, cidr, defineFeature, duration, integer, list, object, oneOf, parseDuration, parseSize, peerAddress, rate, safeLog, size, string, taggedRoutes, toggle, type FeatureOptions, type FeatureSetupContext, type LogMasker, type ServiceRequest, activeSetup, readCertificates, reloadTls, type Logger, type ClientCertificate, type FeatureHook, type OptionFunction, type HandlerMiddleware, type ParsedTags, type RequestMiddleware, type ServerSettings, type TaggedRoute } from "../public.ts";
import type { SecurityRouteOptions } from "./api.ts";
import type { ClientIpResolver, RateLimitRefusal, SecurityApi, SecurityRefusal } from "./api.ts";
import { corsProblems, corsStep, ownOptionsRoutes, routeCorsOptions } from "./cors.ts";
import { Exemptions } from "./exempt.ts";
import { DEFAULT_MASKED_KEYS, masker, secretOptionValues, sensitiveFieldNames } from "./masking.ts";
import { ipStep } from "./ip.ts";
import { BIND_SOURCE, dynamicIpLists, type DynamicIpLists, type IpListSource, type IpSourceSetup } from "./ip-source.ts";
import { DEFAULT_ATTACHMENT_TYPES, fileHeaders } from "./files.ts";
import { DEFAULT_CSP, DEFAULT_DOCS_CSP, headersStep } from "./headers.ts";
import { bodyStep, FORM_OVERHEAD, largestUpload, limitsStep, routeBodyLimit } from "./limits.ts";
import { SECURITY_ITEMS, securityMiddlewares, type RefusalListener, type SecurityMiddlewares, type SecurityStep } from "./pipeline.ts";
import { proxyResolver } from "./proxy.ts";
import { allowProblems, mtlsStep, type ClientCertificateVerifier } from "./mtls.ts";
import { KEY_PARTS, rateLimitStep, routePatterns } from "./rate-limit.ts";
import { loadSheddingStep } from "./shedding.ts";
import { memoryRateLimitStore, type RateLimitStore } from "./store.ts";
import { databaseRateLimitStore, rateLimitCounterEntity } from "./db-store.ts";
import { buildRouteIndex, type RouteIndex } from "./routes.ts";
import { csrfMiddleware, type CsrfContext, type CsrfOptions } from "./csrf.ts";

const options = object({
  proxy: toggle({
    trust: list(cidr()).default([]).describe("The proxies whose forwarding headers are read: addresses, CIDR blocks or loopback, private and linklocal."),
    header: string().default("x-forwarded-for").describe("The header trusted proxies put the client address in: x-forwarded-for, forwarded (RFC 7239) or another comma-separated list."),
    resolver: provider<ClientIpResolver>("ClientIpResolver", ["resolve"])
      .optional()
      .describe("Replaces the trusted walk: its resolve method gets the request and its peer address and returns the client address, which is then normalized."),
  }).describe("Resolves the client address in req.ip through the proxies the project trusts."),
  headers: toggle({
    contentTypeOptions: boolean().default(true).describe("Sends X-Content-Type-Options: nosniff."),
    referrerPolicy: string().default("no-referrer").describe("The Referrer-Policy header; an empty string leaves it out."),
    frameOptions: oneOf(["DENY", "SAMEORIGIN"]).default("DENY").describe("The X-Frame-Options header."),
    csp: string().default(DEFAULT_CSP).describe("The Content-Security-Policy of API responses; an empty string leaves it out."),
    docsCsp: string().default(DEFAULT_DOCS_CSP).describe("The Content-Security-Policy of GET /docs, which lets the API docs page load."),
    hsts: toggle({
      maxAge: duration().default("365d").describe("How long browsers keep to HTTPS, sent in seconds."),
      includeSubDomains: boolean().default(true).describe("Adds includeSubDomains to Strict-Transport-Security."),
      preload: boolean().default(false).describe("Adds preload to Strict-Transport-Security, a commitment that is hard to undo."),
    }).describe("Sends Strict-Transport-Security in production only."),
  }).describe("Sends the standard security headers on every response."),
  files: toggle({
    attachmentTypes: list(string())
      .default(DEFAULT_ATTACHMENT_TYPES)
      .describe("The stored types served with content-disposition: attachment, wildcards allowed; other files stay inline."),
  }).describe("Sends headers on served files (proxy and signed modes) that keep a browser from running them as pages of the service."),
  cors: toggle({
    origins: list(string()).perRequest().default([]).describe('The origins allowed to call the API from a browser: exact origins, "*", subdomain patterns like https://*.example.com, or "null"; none by default.'),
    methods: list(string()).default(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).describe("The methods a preflight may ask for."),
    headers: list(string())
      .default(["content-type", "authorization", "idempotency-key", "if-match", "if-none-match", "x-request-id"])
      .describe("The request headers a preflight may ask for, compared case-insensitively."),
    exposeHeaders: list(string())
      .default(["x-request-id", "etag", "location", "retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"])
      .describe("The response headers a browser lets the calling page read."),
    credentials: boolean().default(false).describe("Allows cookies and authorization with cross-origin requests; not with origins \"*\"."),
    maxAge: duration().default("10m").describe("How long a browser caches a preflight answer."),
    onRejected: hook<SecurityRefusal, undefined>().describe("Runs after a preflight is refused, with the request, address, route and reason."),
  }).describe("Answers cross-origin requests and preflights of the allowed origins; closed until origins are listed."),
  limits: toggle({
    body: size().default("1MB").describe("The largest request body, except multipart uploads, which the file settings limit."),
    headers: size().default("16KB").describe("The largest total length of the request's header names and values."),
    headerCount: integer().min(1).default(100).describe("The most headers a request may have."),
    url: size().default("8KB").describe("The longest path and query string."),
    onRejected: hook<SecurityRefusal, undefined>().describe("Runs after a request is refused for its URL, headers or declared body size."),
  }).describe("Refuses oversized URLs (414), headers (431) and bodies (413) before reading them."),
  timeouts: toggle({
    idle: duration().default("30s").describe("How long a connection may stay idle before it is closed, at most 255s (the Bun limit); 0s turns it off."),
    read: duration().default("30s").describe("How long a request body other than an upload has to arrive, from the first read."),
    upload: duration().default("10m").describe("How long a multipart upload has to arrive, from the first read."),
  }).describe("Closes idle connections and refuses requests whose body arrives too slowly with 408."),
  loadShedding: toggle({
    maxInFlight: integer().min(1).default(1000).describe("The most requests one worker serves at once; more are refused with 503."),
    retryAfter: duration().default("1s").describe("The Retry-After of a refusal, sent in whole seconds."),
    onShed: hook<SecurityRefusal, undefined>().describe("Runs after a request is refused because the worker is busy."),
  }).describe("Refuses new requests with 503 while a worker has too many in flight, so it stays responsive under overload."),
  rateLimit: toggle({
    limit: rate()
      .perRequest()
      .default("1000/min")
      .describe("The requests each bucket may make per window, like 1000/min or 10/s; a function of the request context (req, user and tenant) computes it per request."),
    by: list(oneOf(KEY_PARTS)).default(["ip"]).describe("What a bucket is per: the client address (ip), the route, the user or the tenant, combined."),
    store: anyOf(oneOf(["memory", "database"]), provider<RateLimitStore>("RateLimitStore", ["hit", "reset"]))
      .default("memory")
      .describe('Where the counters live: "memory" keeps them per worker; "database" shares them across workers and replicas through the project\'s database; a RateLimitStore replaces both.'),
    syncInterval: duration().default("1s").describe('How often the "database" store sends its pending counts and reads the shared totals back.'),
    memory: object({
      maxKeys: integer().min(1).default(100_000).describe("The most buckets the memory store keeps; the least recently used one is evicted."),
    }),
    onLimited: hook<RateLimitRefusal, undefined>().describe("Runs after a request is refused with 429, with the bucket's key and limit."),
  }).describe("Limits how many requests each client address makes in a time window, answering 429 with RateLimit headers."),
  ip: toggle({
    allow: list(cidr()).default([]).describe("When not empty, only these addresses are served: addresses, CIDR blocks or loopback, private and linklocal."),
    deny: list(cidr()).default([]).describe("Addresses refused with 403; a deny match wins over an allow match."),
    source: provider<IpListSource>("IpListSource", ["load"])
      .optional()
      .describe("Where more allow and deny entries come from while the service runs, like databaseIpList over a project entity; merged with the config lists, loaded at startup, every refresh and on watch changes."),
    refresh: duration().default("30s").describe("How often the source is loaded again; a load taking longer fails and keeps the lists in effect."),
    onBlocked: hook<SecurityRefusal, undefined>().describe("Runs after a request is refused for its address."),
  }).describe("Accepts or refuses requests by client address (req.ip), for the whole service or with tags for single routes."),
  csrf: toggle({
    mode: oneOf(["origin", "token"])
      .default("origin")
      .describe("How cookie-authenticated writes prove they come from the service's pages: their Origin (or Referer) and Sec-Fetch-Site headers, or a token header equal to the CSRF cookie."),
    origins: list(string()).default([]).describe("Origins allowed to send cookie-authenticated writes besides the service's own and security.cors.origins."),
    cookie: string().default("qs_csrf").describe("The cookie that carries the token in token mode."),
    header: string().default("x-csrf-token").describe("The request header that must repeat the cookie's token in token mode."),
  }).describe("Refuses cross-site writes (POST, PUT, PATCH, DELETE) that ride on a session cookie with 403; requests authenticated by tokens, or not at all, skip it."),
  mtls: toggle({
    mode: oneOf(["required", "optional"])
      .default("required")
      .describe("required refuses clients without a valid certificate in the TLS handshake; optional lets them in, and @mtls protects chosen routes."),
    ca: list(string()).default([]).describe("The certificate authorities client certificates must chain to, as file paths or PEM text; required while mtls is on."),
    allow: list(string())
      .default([])
      .perRequest()
      .describe("The client identities admitted: CN=, O=, OU=, dns: (*. for subdomains), uri: (a trailing * for SPIFFE prefixes), email: or sha256: entries; empty admits every verified certificate. A function of the request, its client and tenant lists them per request."),
    beforeClient: hook<{ client: ClientCertificate; req: ServiceRequest }, undefined>().describe("Runs after a client certificate was verified, with the client and the request; it may return a changed client, or throw an HttpError to refuse."),
    onRejected: hook<SecurityRefusal, undefined>().describe("Runs after a request is refused for its client certificate, with the request, address, route, reason and client."),
    verifier: provider<ClientCertificateVerifier>("ClientCertificateVerifier", ["verify"])
      .optional()
      .describe("Checks a verified client certificate further, like revocation (CRL or OCSP) or SPIFFE trust bundles: true admits it, a text refuses it with 403."),
    forwarded: toggle({
      header: string().default("x-forwarded-client-cert").describe("The header a trusted proxy or service mesh forwards the verified client certificate in."),
      format: oneOf(["xfcc", "pem"]).default("xfcc").describe("xfcc reads Envoy's x-forwarded-client-cert elements (Istio, Linkerd, Envoy); pem reads a URL-encoded certificate (NGINX $ssl_client_escaped_cert)."),
      trust: list(cidr()).default([]).describe("The proxies whose header is read (default: security.proxy.trust); from any other peer the header is removed."),
    })
      .default(false)
      .describe("Takes the client identity a trusted proxy verified and forwarded, so mTLS can terminate in front of the service; server.tls is then not needed."),
  })
    .default(false)
    .describe("Asks callers for client certificates (mutual TLS), verified against the project's authorities, with the identity in req.client."),
  masking: toggle({
    keys: list(string())
      .default(DEFAULT_MASKED_KEYS)
      .describe("A logged property whose name contains one of these (ignoring case, - and _) shows [secret] instead of its value."),
  }).describe("Keeps secret values and fields tagged @sensitive out of log entries, job run records and development error responses."),
});

/** The longest idle timeout Bun accepts, in seconds. */
const MAX_IDLE_SECONDS = 255;

function idleProblems(idle: string): string[] {
  return parseDuration(idle)! > MAX_IDLE_SECONDS * 1000 ? [`Invalid security.timeouts.idle: expected at most ${MAX_IDLE_SECONDS}s (the Bun limit), got ${idle}`] : [];
}

/** The rate limit store of a running setup, and who set it: the config's provider, or a feature. */
interface StoreSlot {
  current: RateLimitStore;
  owner?: string;
  /** False once the app started: the store can no longer be replaced. */
  open: boolean;
}

/** What each running setup shares with the feature API built from the same context. */
interface SetupState {
  exemptions: Exemptions;
  store: StoreSlot;
  /** The masking of log entries, while `masking` is on. */
  mask?: LogMasker;
  /** The route options features gave during setup, by pattern. */
  routeOptions: { pattern: string; tags: ParsedTags }[];
  /** Whether route options are still accepted. */
  open: boolean;
  /** The server settings of the service, whose body limit route options raise. */
  server?: ServerSettings;
  /** The lists of `ip.source`, while one is set. */
  ipLists?: DynamicIpLists;
  /** The counts of the config lists. */
  ipCounts?: { allow: number; deny: number };
  /** The handler-stage middleware delegating to the current steps, and whether it was added. */
  handler?: HandlerMiddleware;
  handlerAdded?: boolean;
  /** Rebuilds the route index and the steps with the route options. */
  rebuild?: () => void;
}

const setupStates = new WeakMap<object, SetupState>();

const isStore = (value: unknown): value is RateLimitStore => typeof value === "object" && value !== null && typeof (value as RateLimitStore).hit === "function" && typeof (value as RateLimitStore).reset === "function";

/** How often one worker deletes the expired counters of the database store. */
export const COUNTER_CLEANUP_INTERVAL = 60_000;

/**
 * The database store of rate limit counters, checked against the build and the adapter, synced every `syncInterval`
 * once the app starts, cleaned every minute by the worker that runs scheduled work, and flushed at shutdown.
 */
function databaseStore(ctx: FeatureSetupContext<SecurityOptions>): RateLimitStore {
  const model = ctx.models.find((candidate) => candidate.key === "RateLimitCounter" && candidate.system);
  if (!model) throw new Error('security.rateLimit.store is "database", but the build did not include RateLimitCounter; rebuild and run quickservicets migration add');
  const adapter = ctx.config.database;
  if (typeof adapter.increment !== "function") throw new Error('security.rateLimit.store "database" needs an adapter with increment()');
  const store = databaseRateLimitStore({ adapter, model, logger: ctx.logger });
  const timers: ReturnType<typeof setInterval>[] = [];
  ctx.app.onStart(() => {
    timers.push(setInterval(() => void store.sync(), parseDuration(ctx.options.rateLimit.syncInterval)!));
    if (ctx.worker.runsScheduledWork) {
      const clean = () =>
        store.cleanup().catch((error: unknown) =>
          safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "security.rateLimit.cleanup-failed", error: { message: (error as Error)?.message ?? String(error) } }),
        );
      timers.push(setInterval(() => void clean(), COUNTER_CLEANUP_INTERVAL));
    }
  });
  ctx.app.onStop(async () => {
    for (const timer of timers.splice(0)) clearInterval(timer);
    await store.sync();
  });
  return store;
}

/** The options of the `mtls` item. */
interface MtlsOptions {
  enabled: boolean;
  mode: "required" | "optional";
  ca: string[];
  allow: string[] | OptionFunction<string[]>;
  beforeClient: FeatureHook<{ client: ClientCertificate; req: ServiceRequest }, undefined>[];
  verifier?: ClientCertificateVerifier;
  forwarded: { enabled: boolean; header: string; format: "xfcc" | "pem"; trust: string[] };
}

/** The problems of the mtls item: server.tls must be set, an authority given, and every allow entry valid. */
function mtlsProblems(mtls: MtlsOptions, config: Readonly<Record<string, unknown>>): string[] {
  const tls = (config.server as { tls?: { cert?: string } } | undefined)?.tls;
  // With forwarded certificates the proxy verified them: no TLS of the service's own and no authorities are needed.
  const allow = typeof mtls.allow === "function" ? [] : allowProblems(mtls.allow);
  if (mtls.forwarded.enabled) return allow;
  return [
    ...(tls?.cert === undefined ? ["security.mtls needs server.tls"] : []),
    ...(mtls.ca.length === 0 ? ["Invalid security.mtls.ca: give the certificate authorities client certificates chain to"] : []),
    ...allow,
  ];
}

/** The message of a project serving WebSockets while the service checks client certificates itself. */
export const MTLS_WEBSOCKETS = "realtime.websockets is not available while the service verifies client certificates itself; terminate mTLS at a proxy and use security.mtls.forwarded";

/** Makes the server ask for client certificates: it then listens through `node:tls`, which gives them per request. */
function setUpClientCertificates(ctx: FeatureSetupContext<SecurityOptions>): void {
  const mtls = ctx.options.mtls as MtlsOptions;
  if (taggedRoutes().some((route) => route.kind === "websocket")) throw new Error(MTLS_WEBSOCKETS);
  ctx.app.configureServer({ clientCertificates: { ca: readCertificates(mtls.ca, "security.mtls.ca").pems, required: mtls.mode === "required", sources: [...mtls.ca] } });
}

/** What the steps share across rebuilds: the rate limit store and the load shedding step, which hold state. */
interface SharedSteps {
  logger?: Logger;
  store?: RateLimitStore;
  shedding?: SecurityStep;
  /** The lists of `ip.source`, which the `ip` step reads per request. */
  ipLists?: DynamicIpLists;
}

/** Prepares the parts of the steps that hold state, once per setup. */
function sharedSteps(ctx: FeatureSetupContext<SecurityOptions>, slot: StoreSlot): SharedSteps {
  const { options } = ctx;
  const shared: SharedSteps = { logger: ctx.logger };
  if (options.rateLimit.enabled) {
    const { rateLimit } = options;
    if (isStore(rateLimit.store)) slot.current = rateLimit.store;
    else if (rateLimit.store === "database") slot.current = databaseStore(ctx);
    if (rateLimit.store === "memory" && Math.max(ctx.worker.count, ctx.config.server.workers) > 1) {
      safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: 'security.rateLimit uses per-worker memory counters; set security.rateLimit.store to "database" to share them' });
    }
    // A feature may still replace the store during setup, so hits go through the slot.
    shared.store = { hit: (key, hit) => slot.current.hit(key, hit), reset: (key) => slot.current.reset(key) };
  }
  const source = options.ip.enabled ? (options.ip.source as IpListSource | undefined) : undefined;
  if (source) {
    // A source reading the project's database checks its entity now, so a wrong one fails startup.
    (source as { [BIND_SOURCE]?: (setup: IpSourceSetup) => void })[BIND_SOURCE]?.({ models: ctx.models, database: ctx.config.database });
    const lists = dynamicIpLists({ config: options.ip, source, refreshMs: parseDuration(options.ip.refresh) ?? 30_000, logger: ctx.logger });
    // Each worker loads the source before its listener accepts requests; a failed load keeps the config lists.
    ctx.app.onStart(() => lists.start());
    ctx.app.onStop(() => lists.stop());
    shared.ipLists = lists;
  }
  if (options.loadShedding.enabled) {
    const shedding = loadSheddingStep(options.loadShedding, ctx.logger);
    ctx.app.onStop(() => shedding.stop());
    shared.shedding = shedding;
  }
  return shared;
}

/** The steps of the enabled items, in no particular order; the pipeline orders them. */
function itemSteps(options: SecurityOptions, production: boolean, shared: SharedSteps, index: () => RouteIndex | undefined, ipOf: (request: Request) => string): SecurityStep[] {
  const steps: SecurityStep[] = [];
  if (options.rateLimit.enabled) {
    const { rateLimit } = options;
    steps.push(rateLimitStep(rateLimit, { store: shared.store!, ipOf, tagged: index()?.routes ?? [], ...(rateLimit.by.includes("route") ? { routes: routePatterns(taggedRoutes()) } : {}) }));
  }
  if (options.headers.enabled) steps.push(headersStep(options.headers, production));
  if (shared.shedding) steps.push(shared.shedding);
  if (options.ip.enabled) {
    const step = ipStep(options.ip, ipOf, index()?.routes ?? [], undefined, shared.ipLists);
    if (step) steps.push(step);
  }
  if (options.cors.enabled) steps.push(corsStep(options.cors, ownOptionsRoutes(taggedRoutes()), index, ipOf));
  if (options.mtls.enabled) {
    const mtls = options.mtls as MtlsOptions;
    const forwarded = mtls.forwarded.enabled ? { header: mtls.forwarded.header.toLowerCase(), format: mtls.forwarded.format, trust: mtls.forwarded.trust.length > 0 ? mtls.forwarded.trust : options.proxy.trust } : undefined;
    steps.push(
      mtlsStep({
        allow: mtls.allow,
        logger: shared.logger!,
        required: mtls.mode === "required",
        production,
        beforeClient: mtls.beforeClient,
        ...(mtls.verifier ? { verifier: mtls.verifier } : {}),
        ...(forwarded ? { forwarded } : {}),
      }),
    );
  }
  if (options.limits.enabled) steps.push(limitsStep(options.limits));
  if (options.limits.enabled || options.timeouts.enabled) {
    const timeouts = options.timeouts.enabled ? options.timeouts : undefined;
    steps.push(
      bodyStep({
        ...(options.limits.enabled ? { maxBytes: parseSize(options.limits.body)!, byRoute: (index()?.routes ?? []).some((route) => route.tags.limits) } : {}),
        ...(timeouts ? { read: parseDuration(timeouts.read)!, upload: parseDuration(timeouts.upload)! } : {}),
      }),
    );
  }
  return steps;
}

/** The methods a route option covers: every method a route may have. */
const ROUTE_OPTION_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** The tags a route option stands for, as the items read them from a tagged route. */
export function routeOptionTags(options: SecurityRouteOptions): ParsedTags {
  const tags: ParsedTags = {};
  if (options.rateLimit) tags.rateLimit = { on: true, options: { limit: options.rateLimit.limit, ...(options.rateLimit.by ? { by: [...options.rateLimit.by] } : {}) } };
  if (options.cors) tags.cors = { on: true, options: { ...options.cors } };
  if (options.ip?.allow) tags.ipAllow = { on: true, options: { allow: [...options.ip.allow] } };
  if (options.ip?.deny) tags.ipDeny = { on: true, options: { deny: [...options.ip.deny] } };
  if (options.limits) tags.limits = { on: true, options: { body: options.limits.body } };
  return tags;
}

/** Whether a route path is covered by a route option's pattern: the same path, or a path under its `/*` prefix. */
function coveredBy(pattern: string, path: string): boolean {
  if (!pattern.endsWith("/*")) return path === pattern;
  const prefix = pattern.slice(0, -2);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The app's routes with the tags of the route options added: to the routes they cover, and as routes of their own. */
export function withRouteOptions(routes: readonly TaggedRoute[], entries: readonly { pattern: string; tags: ParsedTags }[]): TaggedRoute[] {
  const merged = routes.map((route) => {
    const tags = entries.filter((entry) => coveredBy(entry.pattern, route.path)).reduce<ParsedTags | undefined>((all, entry) => ({ ...all, ...entry.tags }), undefined);
    return tags ? { ...route, tags: { ...route.tags, ...tags } } : route;
  });
  const taken = new Set(merged.map((route) => `${route.method} ${route.path}`));
  for (const entry of entries) {
    const path = entry.pattern.endsWith("/*") ? `${entry.pattern.slice(0, -2) === "/" ? "" : entry.pattern.slice(0, -2)}/[...rest]` : entry.pattern;
    for (const method of ROUTE_OPTION_METHODS) {
      if (taken.has(`${method} ${path}`)) continue;
      taken.add(`${method} ${path}`);
      merged.push({ method, path, tags: entry.tags } as TaggedRoute);
    }
  }
  return merged;
}

type SecurityOptions = FeatureOptions<typeof options>;

/** The hook option of each item whose refusals run hooks. */
const REFUSAL_HOOKS = { rateLimit: "onLimited", ip: "onBlocked", cors: "onRejected", loadShedding: "onShed", limits: "onRejected", mtls: "onRejected" } as const;

/**
 * Runs the item's after-hooks once a refusal is decided, with the request, its address and route, the item and the
 * reason; a failing hook is logged and never changes the response. Undefined when no hook is set.
 */
function refusalHooks(ctx: FeatureSetupContext<SecurityOptions>, ipOf: (request: Request) => string): RefusalListener | undefined {
  const lists = Object.fromEntries(
    Object.entries(REFUSAL_HOOKS).map(([item, name]) => [item, (ctx.options[item as keyof typeof REFUSAL_HOOKS] as unknown as Record<string, ((value: never, ctx: undefined) => unknown)[]>)[name] ?? []]),
  );
  if (Object.values(lists).every((list) => list.length === 0)) return undefined;
  let patterns: ReturnType<typeof routePatterns> | undefined;
  return (state, refusal) => {
    const list = lists[refusal.item];
    if (!list || list.length === 0) return;
    const { request, url } = state.ctx;
    patterns ??= routePatterns(taggedRoutes());
    const route = patterns.of(request.method, url.pathname);
    const value = { request, ip: ipOf(request), route: route === "-" ? undefined : route, item: refusal.item, reason: refusal.reason, ...refusal.details };
    void runAfterHooks(list as never, value as never, undefined);
  };
}

/**
 * The refusal listener with the `quickservicets.security.rate_limited` counter added while a meter is set, counting
 * each 429 of a rate limit by route (`unmatched` outside the routes).
 */
function withRateLimitMetric(hooks: RefusalListener | undefined): RefusalListener {
  let patterns: ReturnType<typeof routePatterns> | undefined;
  return (state, refusal) => {
    if (refusal.item === "rateLimit" && metricsEnabled()) {
      patterns ??= routePatterns(taggedRoutes());
      const route = patterns.of(state.ctx.request.method, state.ctx.url.pathname);
      coreInstruments().rateLimited.add(1, { "http.route": route === "-" ? "unmatched" : route.replace(/^[A-Z]+ /, "") });
    }
    hooks?.(state, refusal);
  };
}

/**
 * The `security` native: safe defaults for every service, as separate items that can each be adjusted or switched
 * off, run in a fixed order before routing. Enabled by default; `security: false` removes it all.
 */
const securityFeature = defineFeature({
  key: "security",
  docs: { summary: "Safe defaults for every service: security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists and log masking, each a switchable item." },
  enabledByDefault: true,
  options,
  // The shared counters are part of the model only while the database store is on.
  entities: ({ options }) => (options.rateLimit.enabled && options.rateLimit.store === "database" ? [rateLimitCounterEntity()] : []),
  validate: (resolved, config) => [
    ...(resolved.cors.enabled ? corsProblems(resolved.cors, "security.cors") : []),
    ...(resolved.timeouts.enabled ? idleProblems(resolved.timeouts.idle) : []),
    ...(resolved.mtls.enabled ? mtlsProblems(resolved.mtls as MtlsOptions, config) : []),
  ],
  tags: {
    limits: {
      on: ["endpoint", "entity"],
      scope: "limits",
      options: ["body"],
      description: "Raises or lowers the body limit of one route, or of each route of an entity, like an import endpoint that takes large JSON bodies.",
      example: "/** @limits body=20MB */\nexport default handler;",
    },
    sensitive: {
      on: ["field"],
      description: "Marks a field whose value never appears in log entries or job run records, shown there as [sensitive]; API responses keep it (use @hidden to leave it out).",
      example: "export type Customer = {\n  /** @sensitive */\n  taxId: string;\n};",
    },
    ipAllow: {
      on: ["endpoint", "entity"],
      scope: "ip",
      shorthand: "allow",
      options: ["allow"],
      description: "Serves one route, or each route of an entity, only to the listed addresses, on top of the global lists.",
      example: "/** @ipAllow private,loopback */\nexport default handler;",
    },
    ipDeny: {
      on: ["endpoint", "entity"],
      scope: "ip",
      shorthand: "deny",
      options: ["deny"],
      description: "Refuses the listed addresses on one route, or on each route of an entity, on top of the global lists.",
      example: "/** @ipDeny 203.0.113.0/24 */\nexport default handler;",
    },
    rateLimit: {
      on: ["endpoint", "entity"],
      scope: "rateLimit",
      shorthand: "limit",
      options: ["limit", "by"],
      description: "Gives one route, or each route of an entity, its own rate limit on top of the global one, always keyed by route; `@rateLimit off` exempts the route from every rate limit.",
      example: "/** @rateLimit 10/min by=user */\nexport default handler;",
    },
    cors: {
      on: ["endpoint", "entity"],
      scope: "cors",
      options: ["origins", "credentials", "methods", "headers"],
      description: "Replaces the CORS options for the preflights and requests of one route or of an entity's routes; `@cors off` turns CORS handling off there.",
      example: "/** @cors origins=https://partner.example credentials=true */\nexport default handler;",
    },
    csrf: {
      on: ["endpoint", "entity"],
      scope: "csrf",
      description: "`@csrf off` lets one route, or each route of an entity, accept cookie-authenticated writes from other sites, like a beacon endpoint.",
      example: "/** @csrf off */\nexport default handler;",
    },
    mtls: {
      on: ["endpoint", "entity"],
      scope: "mtls",
      options: ["allow"],
      description: "`@mtls` requires a verified client certificate on one route, or on each route of an entity, even in optional mode (401 without one); `allow=` replaces the global allowlist there, and `@mtls off` skips the identity checks.",
      example: "/** @mtls allow=CN=billing */\nexport default handler;",
    },
    securityHeaders: {
      on: ["endpoint", "entity"],
      scope: "headers",
      options: ["csp", "frameOptions", "referrerPolicy"],
      description: "Changes the security headers of one route or of an entity's routes; `@securityHeaders off` sends none of them there.",
      example: "/** @securityHeaders csp=\"default-src 'self'\" */\nexport default handler;",
    },
  },
  setup(ctx) {
    const exemptions = new Exemptions();
    const slot: StoreSlot = { current: memoryRateLimitStore({ maxKeys: ctx.options.rateLimit.memory.maxKeys }), open: true, ...(isStore(ctx.options.rateLimit.store) ? { owner: "the config" } : {}) };
    setupStates.set(ctx.app, { exemptions, store: slot, routeOptions: [], open: true });
    const enabled: string[] = SECURITY_ITEMS.filter((item) => ctx.options[item].enabled);
    if (ctx.options.mtls.enabled) {
      enabled.push("mtls");
      if (!(ctx.options.mtls as MtlsOptions).forwarded.enabled) setUpClientCertificates(ctx);
    }
    // Routes are indexed only when one carries a security tag, so other requests do no lookup.
    let index: RouteIndex | undefined = buildRouteIndex(taggedRoutes(), Object.keys(securityFeature.tags ?? {}));
    const problems = (index?.routes ?? []).flatMap((route) => (route.tags.cors?.on ? corsProblems(routeCorsOptions(ctx.options.cors, route), `@cors of ${route.method} ${route.path}`) : []));
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const proxy = ctx.options.proxy;
    // Without trusted proxies, req.ip is the peer address; production still checks for forwarded headers to warn once.
    let ipOf: (request: Request) => string = peerAddress;
    if (proxy.enabled && (proxy.resolver !== undefined || proxy.trust.length > 0 || ctx.config.production)) {
      const untrusted = (peer: string) =>
        safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "security.proxy.untrusted", peer, header: proxy.header, hint: "set security.proxy.trust if the service runs behind a proxy" });
      const custom = proxy.resolver;
      // A resolver of the project replaces the trusted walk; its answer is normalized like the walk's.
      const resolve = custom
        ? (request: Request, peer: string) => {
            const address = custom.resolve({ request, peer });
            return (typeof address === "string" ? normalizeAddress(address) : undefined) ?? peer;
          }
        : proxyResolver(proxy, ctx.config.production ? untrusted : undefined);
      // Items before routing and req.ip read the same address, computed once per request.
      const resolved = new WeakMap<Request, string>();
      const clientIp = (request: Request, peer: string) => {
        let ip = resolved.get(request);
        if (ip === undefined) resolved.set(request, (ip = resolve(request, peer)));
        return ip;
      };
      ctx.app.configureServer({ clientIp });
      ipOf = (request) => clientIp(request, peerAddress(request));
    }
    const shared = sharedSteps(ctx, slot);
    setupStates.get(ctx.app)!.ipLists = shared.ipLists;
    setupStates.get(ctx.app)!.ipCounts = { allow: ctx.options.ip.allow.length, deny: ctx.options.ip.deny.length };
    const steps = itemSteps(ctx.options, ctx.config.production, shared, () => index, ipOf);
    if (ctx.options.limits.enabled) {
      // The socket refuses bodies no route could accept: larger than every body limit and than any upload the model allows.
      const upload = largestUpload(ctx.models, ctx.config.files.maxSize);
      const tagged = (index?.routes ?? []).map((route) => routeBodyLimit(route) ?? 0);
      ctx.app.configureServer({ maxRequestBodySize: Math.max(parseSize(ctx.options.limits.body)!, ...tagged, upload > 0 ? upload + FORM_OVERHEAD : 0) });
    }
    // Route options of later features raise the socket's limit on the same server settings.
    const state = setupStates.get(ctx.app)!;
    state.server = activeSetup()?.server;
    if (ctx.options.masking.enabled) {
      const secrets = [
        ...secretVariableValues(),
        ...ctx.config.features.flatMap((feature) => secretOptionValues(feature.definition.schema, feature.options)),
        ...(ctx.config.files?.signingSecret ? [ctx.config.files.signingSecret] : []),
      ];
      const mask = masker({ keys: ctx.options.masking.keys, sensitive: sensitiveFieldNames(ctx.models), secrets });
      setupStates.get(ctx.app)!.mask = mask;
      ctx.app.configureServer({ mask });
    }
    if (ctx.options.timeouts.enabled) ctx.app.configureServer({ idleTimeout: Math.ceil(parseDuration(ctx.options.timeouts.idle)! / 1000) });
    if (ctx.options.files.enabled) ctx.app.configureServer({ fileHeaders: fileHeaders(ctx.options.files.attachmentTypes) });
    // Only the auth native authenticates requests by cookie, so without it no request needs the check.
    if (ctx.options.csrf.enabled && ctx.config.features.some((feature) => feature.key === "auth")) {
      const decisions = new Map<string, boolean>();
      const appliesTo = (req: ServiceRequest) => {
        const key = `${req.method} ${req.route}`;
        let applies = decisions.get(key);
        if (applies === undefined) decisions.set(key, (applies = (securityFeature.optionsFor(req).csrf as { enabled: boolean }).enabled));
        return applies;
      };
      ctx.app.use(
        csrfMiddleware(ctx.options.csrf as CsrfOptions, {
          corsOrigins: ctx.options.cors.enabled ? (ctx.options.cors.origins as CsrfContext["corsOrigins"]) : undefined,
          proxy: ctx.options.proxy,
          production: ctx.config.production,
          appliesTo,
          logger: ctx.logger,
        }),
      );
    }
    if (steps.length > 0) {
      const refusals = withRateLimitMetric(refusalHooks(ctx, ipOf));
      let current: SecurityMiddlewares = securityMiddlewares(steps, exemptions, () => index, refusals);
      if (current.handler) state.handlerAdded = true;
      // The middlewares delegate to the current steps, which route options of later features rebuild once at start.
      const request: RequestMiddleware = { stage: "request", order: -1000, run: (context, next) => current.request.run(context, next) };
      const handler: HandlerMiddleware = { stage: "handler", order: 1000, run: (req, res, next) => (current.handler ? current.handler.run(req, res, next) : next()) };
      ctx.app.use(request);
      if (current.handler) ctx.app.use(handler);
      state.handler = handler;
      state.rebuild = () => {
        index = buildRouteIndex(withRouteOptions(taggedRoutes(), state.routeOptions), Object.keys(securityFeature.tags ?? {}));
        current = securityMiddlewares(itemSteps(ctx.options, ctx.config.production, shared, () => index, ipOf), exemptions, () => index, refusals);
      };
    }
    // Features that run after this one add their exemptions in their own setup; the list is final once the app starts.
    ctx.app.onStart(() => {
      exemptions.close();
      slot.open = false;
      state.open = false;
      if (state.routeOptions.length > 0) state.rebuild?.();
    });
    safeLog(ctx.logger, "info", { timestamp: new Date().toISOString(), message: "security.enabled", items: enabled });
  },
  api: (ctx): SecurityApi => {
    const { exemptions, store } = setupStates.get(ctx.app)!;
    const state = setupStates.get(ctx.app)!;
    return {
      masker: () => state.mask,
      exempt: (pattern, items) => exemptions.add(pattern, items),
      reloadTls: () => reloadTls(ctx.logger),
      ip: {
        reload: () => (state.ipLists ? state.ipLists.reload() : Promise.resolve({ ...(state.ipCounts ?? { allow: 0, deny: 0 }) })),
      },
      routeOptions(pattern, options) {
        if (!state.open || !activeSetup()) throw new Error("security routeOptions() is only available during setup");
        if (typeof pattern !== "string" || !/^\/[^*]*(\/\*)?$/.test(pattern)) throw new Error(`Invalid security route pattern ${JSON.stringify(pattern)}: expected a path or a prefix ending in /*`);
        const tags = routeOptionTags(options ?? {});
        if (Object.keys(tags).length === 0) return;
        const caller = ctx.currentFeature() ?? "a feature";
        if (tags.cors) {
          const problems = corsProblems(routeCorsOptions(ctx.options.cors, { tags } as never), `security route options of ${pattern} (${caller})`);
          if (problems.length > 0) throw new Error(problems.join("\n"));
        }
        state.routeOptions.push({ pattern, tags });
        const body = tags.limits ? parseSize(tags.limits.options.body as string | number) : undefined;
        if (body !== undefined && ctx.options.limits.enabled && state.server && body > (state.server.maxRequestBodySize ?? 0)) state.server.maxRequestBodySize = body;
        // A limit keyed by user or tenant, or computed per request, runs in the handler stage, which the caller adds.
        const late = tags.rateLimit && (typeof tags.rateLimit.options.limit === "function" || ((tags.rateLimit.options.by as string[] | undefined) ?? []).some((part) => part === "user" || part === "tenant"));
        if (late && !state.handlerAdded && state.handler) {
          activeSetup()?.use?.(state.handler);
          state.handlerAdded = true;
        }
      },
      limit(pattern, options) {
        this.routeOptions(pattern, { rateLimit: { limit: options.limit, ...(options.by ? { by: options.by } : {}) } });
      },
      rateLimitStore(replacement) {
        const caller = ctx.currentFeature() ?? "a feature";
        if (!store.open) throw new Error("security rateLimitStore() is only available during setup");
        if (!isStore(replacement)) throw new Error("security rateLimitStore() expects a RateLimitStore with the methods hit, reset");
        if (store.owner !== undefined) throw new Error(`security.rateLimit.store is set by both ${store.owner} and ${caller}`);
        store.owner = caller;
        store.current = replacement;
      },
    };
  },
});

export default securityFeature;
export { securityFeature };
export type { ClientIpResolver, RateLimitRefusal, SecurityApi, SecurityIpApi, SecurityRefusal, SecurityRouteOptions } from "./api.ts";
export type { ClientCertificateVerifier } from "./mtls.ts";
export type { ExemptibleItem } from "./exempt.ts";
export { memoryRateLimitStore, slidingWindowHit } from "./store.ts";
export { DEFAULT_MASKED_KEYS, maskEntry, maskText, maskUrl } from "./masking.ts";
export type { MaskingRules } from "./masking.ts";
export { databaseRateLimitStore } from "./db-store.ts";
export { databaseIpList, dynamicIpLists } from "./ip-source.ts";
export type { DynamicIpLists, IpListCounts, IpListSource } from "./ip-source.ts";
export { csrfMiddleware, csrfRejected } from "./csrf.ts";
export type { CsrfOptions } from "./csrf.ts";
export type { DatabaseRateLimitStore } from "./db-store.ts";
export type { MemoryRateLimitStore, RateLimitHit, RateLimitResult, RateLimitStore, WindowCounts } from "./store.ts";
