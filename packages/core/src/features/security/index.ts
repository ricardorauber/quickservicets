import { boolean, cidr, defineFeature, duration, integer, list, object, oneOf, parseDuration, parseSize, peerAddress, rate, safeLog, size, string, taggedRoutes, toggle, type FeatureOptions, type FeatureSetupContext } from "../public.ts";
import type { SecurityApi } from "./api.ts";
import { corsProblems, corsStep, ownOptionsRoutes, routeCorsOptions } from "./cors.ts";
import { Exemptions } from "./exempt.ts";
import { ipStep } from "./ip.ts";
import { DEFAULT_ATTACHMENT_TYPES, fileHeaders } from "./files.ts";
import { DEFAULT_CSP, DEFAULT_DOCS_CSP, headersStep } from "./headers.ts";
import { bodyStep, FORM_OVERHEAD, largestUpload, limitsStep } from "./limits.ts";
import { SECURITY_ITEMS, securityMiddlewares, type SecurityStep } from "./pipeline.ts";
import { proxyResolver } from "./proxy.ts";
import { KEY_PARTS, rateLimitStep, routePatterns } from "./rate-limit.ts";
import { loadSheddingStep } from "./shedding.ts";
import { memoryRateLimitStore, type RateLimitStore } from "./store.ts";
import { databaseRateLimitStore, rateLimitCounterEntity } from "./db-store.ts";
import { buildRouteIndex, type RouteIndex } from "./routes.ts";

const options = object({
  proxy: toggle({
    trust: list(cidr()).default([]).describe("The proxies whose forwarding headers are read: addresses, CIDR blocks or loopback, private and linklocal."),
    header: string().default("x-forwarded-for").describe("The header trusted proxies put the client address in: x-forwarded-for, forwarded (RFC 7239) or another comma-separated list."),
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
    origins: list(string()).default([]).describe('The origins allowed to call the API from a browser: exact origins, "*", subdomain patterns like https://*.example.com, or "null"; none by default.'),
    methods: list(string()).default(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).describe("The methods a preflight may ask for."),
    headers: list(string())
      .default(["content-type", "authorization", "idempotency-key", "if-match", "if-none-match", "x-request-id"])
      .describe("The request headers a preflight may ask for, compared case-insensitively."),
    exposeHeaders: list(string())
      .default(["x-request-id", "etag", "location", "retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"])
      .describe("The response headers a browser lets the calling page read."),
    credentials: boolean().default(false).describe("Allows cookies and authorization with cross-origin requests; not with origins \"*\"."),
    maxAge: duration().default("10m").describe("How long a browser caches a preflight answer."),
  }).describe("Answers cross-origin requests and preflights of the allowed origins; closed until origins are listed."),
  limits: toggle({
    body: size().default("1MB").describe("The largest request body, except multipart uploads, which the file settings limit."),
    headers: size().default("16KB").describe("The largest total length of the request's header names and values."),
    headerCount: integer().min(1).default(100).describe("The most headers a request may have."),
    url: size().default("8KB").describe("The longest path and query string."),
  }).describe("Refuses oversized URLs (414), headers (431) and bodies (413) before reading them."),
  timeouts: toggle({
    idle: duration().default("30s").describe("How long a connection may stay idle before it is closed, at most 255s (the Bun limit); 0s turns it off."),
    read: duration().default("30s").describe("How long a request body other than an upload has to arrive, from the first read."),
    upload: duration().default("10m").describe("How long a multipart upload has to arrive, from the first read."),
  }).describe("Closes idle connections and refuses requests whose body arrives too slowly with 408."),
  loadShedding: toggle({
    maxInFlight: integer().min(1).default(1000).describe("The most requests one worker serves at once; more are refused with 503."),
    retryAfter: duration().default("1s").describe("The Retry-After of a refusal, sent in whole seconds."),
  }).describe("Refuses new requests with 503 while a worker has too many in flight, so it stays responsive under overload."),
  rateLimit: toggle({
    limit: rate()
      .perRequest()
      .default("1000/min")
      .describe("The requests each bucket may make per window, like 1000/min or 10/s; a function of the request context (req, user and tenant) computes it per request."),
    by: list(oneOf(KEY_PARTS)).default(["ip"]).describe("What a bucket is per: the client address (ip), the route, the user or the tenant, combined."),
    store: oneOf(["memory", "database"])
      .default("memory")
      .describe('Where the counters live: "memory" keeps them per worker; "database" shares them across workers and replicas through the project\'s database.'),
    syncInterval: duration().default("1s").describe('How often the "database" store sends its pending counts and reads the shared totals back.'),
    memory: object({
      maxKeys: integer().min(1).default(100_000).describe("The most buckets the memory store keeps; the least recently used one is evicted."),
    }),
  }).describe("Limits how many requests each client address makes in a time window, answering 429 with RateLimit headers."),
  ip: toggle({
    allow: list(cidr()).default([]).describe("When not empty, only these addresses are served: addresses, CIDR blocks or loopback, private and linklocal."),
    deny: list(cidr()).default([]).describe("Addresses refused with 403; a deny match wins over an allow match."),
  }).describe("Accepts or refuses requests by client address (req.ip), for the whole service or with tags for single routes."),
  masking: toggle({}).describe("Keeps secret values and sensitive fields out of logs and error responses."),
});

/** The longest idle timeout Bun accepts, in seconds. */
const MAX_IDLE_SECONDS = 255;

function idleProblems(idle: string): string[] {
  return parseDuration(idle)! > MAX_IDLE_SECONDS * 1000 ? [`Invalid security.timeouts.idle: expected at most ${MAX_IDLE_SECONDS}s (the Bun limit), got ${idle}`] : [];
}

/** The exemptions of each running setup, shared by the setup and the feature API built from the same context. */
const exemptionsOf = new WeakMap<object, Exemptions>();

/** How often one worker deletes the expired counters of the database store. */
export const COUNTER_CLEANUP_INTERVAL = 60_000;

/**
 * The database store of rate limit counters, checked against the build and the adapter, synced every `syncInterval`
 * once the app starts, cleaned every minute by the worker that runs scheduled work, and flushed at shutdown.
 */
function databaseStore(ctx: FeatureSetupContext<SecurityOptions>): RateLimitStore {
  const model = ctx.models.find((candidate) => candidate.key === "RateLimitCounter" && candidate.system);
  if (!model) throw new Error('security.rateLimit.store is "database", but the build did not include RateLimitCounter; rebuild and run quickservice migration add');
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

/** The steps of the enabled items, in no particular order; the pipeline orders them. */
function itemSteps(ctx: FeatureSetupContext<SecurityOptions>, index: () => RouteIndex | undefined, ipOf: (request: Request) => string): SecurityStep[] {
  const { options } = ctx;
  const steps: SecurityStep[] = [];
  if (options.rateLimit.enabled) {
    const { rateLimit } = options;
    const store = rateLimit.store === "database" ? databaseStore(ctx) : memoryRateLimitStore({ maxKeys: rateLimit.memory.maxKeys });
    if (rateLimit.store === "memory" && Math.max(ctx.worker.count, ctx.config.server.workers) > 1) {
      safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: 'security.rateLimit uses per-worker memory counters; set security.rateLimit.store to "database" to share them' });
    }
    steps.push(rateLimitStep(rateLimit, { store, ipOf, tagged: index()?.routes ?? [], ...(rateLimit.by.includes("route") ? { routes: routePatterns(taggedRoutes()) } : {}) }));
  }
  if (options.headers.enabled) steps.push(headersStep(options.headers, ctx.config.production));
  if (options.loadShedding.enabled) {
    const shedding = loadSheddingStep(options.loadShedding, ctx.logger);
    ctx.app.onStop(() => shedding.stop());
    steps.push(shedding);
  }
  if (options.ip.enabled) {
    const step = ipStep(options.ip, ipOf, index()?.routes ?? []);
    if (step) steps.push(step);
  }
  if (options.cors.enabled) steps.push(corsStep(options.cors, ownOptionsRoutes(taggedRoutes()), index));
  if (options.limits.enabled) steps.push(limitsStep(options.limits));
  if (options.limits.enabled || options.timeouts.enabled) {
    const timeouts = options.timeouts.enabled ? options.timeouts : undefined;
    steps.push(
      bodyStep({
        ...(options.limits.enabled ? { maxBytes: parseSize(options.limits.body)! } : {}),
        ...(timeouts ? { read: parseDuration(timeouts.read)!, upload: parseDuration(timeouts.upload)! } : {}),
      }),
    );
  }
  return steps;
}

type SecurityOptions = FeatureOptions<typeof options>;

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
  validate: (resolved) => [...(resolved.cors.enabled ? corsProblems(resolved.cors, "security.cors") : []), ...(resolved.timeouts.enabled ? idleProblems(resolved.timeouts.idle) : [])],
  tags: {
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
    exemptionsOf.set(ctx.app, exemptions);
    const enabled = SECURITY_ITEMS.filter((item) => ctx.options[item].enabled);
    // Routes are indexed only when one carries a security tag, so other requests do no lookup.
    const index: RouteIndex | undefined = buildRouteIndex(taggedRoutes(), Object.keys(securityFeature.tags ?? {}));
    const problems = (index?.routes ?? []).flatMap((route) => (route.tags.cors?.on ? corsProblems(routeCorsOptions(ctx.options.cors, route), `@cors of ${route.method} ${route.path}`) : []));
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const proxy = ctx.options.proxy;
    // Without trusted proxies, req.ip is the peer address; production still checks for forwarded headers to warn once.
    let ipOf: (request: Request) => string = peerAddress;
    if (proxy.enabled && (proxy.trust.length > 0 || ctx.config.production)) {
      const untrusted = (peer: string) =>
        safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "security.proxy.untrusted", peer, header: proxy.header, hint: "set security.proxy.trust if the service runs behind a proxy" });
      const resolve = proxyResolver(proxy, ctx.config.production ? untrusted : undefined);
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
    const steps = itemSteps(ctx, () => index, ipOf);
    if (ctx.options.limits.enabled) {
      // The socket refuses bodies no route could accept: larger than the body limit and than any upload the model allows.
      const upload = largestUpload(ctx.models, ctx.config.files.maxSize);
      ctx.app.configureServer({ maxRequestBodySize: Math.max(parseSize(ctx.options.limits.body)!, upload > 0 ? upload + FORM_OVERHEAD : 0) });
    }
    if (ctx.options.timeouts.enabled) ctx.app.configureServer({ idleTimeout: Math.ceil(parseDuration(ctx.options.timeouts.idle)! / 1000) });
    if (ctx.options.files.enabled) ctx.app.configureServer({ fileHeaders: fileHeaders(ctx.options.files.attachmentTypes) });
    if (steps.length > 0) {
      const middlewares = securityMiddlewares(steps, exemptions, () => index);
      ctx.app.use(middlewares.request);
      if (middlewares.handler) ctx.app.use(middlewares.handler);
    }
    // Features that run after this one add their exemptions in their own setup; the list is final once the app starts.
    ctx.app.onStart(() => exemptions.close());
    safeLog(ctx.logger, "info", { timestamp: new Date().toISOString(), message: "security.enabled", items: enabled });
  },
  api: (ctx): SecurityApi => {
    const exemptions = exemptionsOf.get(ctx.app)!;
    return { exempt: (pattern, items) => exemptions.add(pattern, items) };
  },
});

export default securityFeature;
export { securityFeature };
export type { SecurityApi } from "./api.ts";
export type { ExemptibleItem } from "./exempt.ts";
export { memoryRateLimitStore, slidingWindowHit } from "./store.ts";
export { databaseRateLimitStore } from "./db-store.ts";
export type { DatabaseRateLimitStore } from "./db-store.ts";
export type { MemoryRateLimitStore, RateLimitHit, RateLimitResult, RateLimitStore, WindowCounts } from "./store.ts";
