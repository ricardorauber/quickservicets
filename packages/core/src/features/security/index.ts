import { boolean, cidr, defineFeature, duration, list, object, oneOf, safeLog, string, taggedRoutes, toggle, type FeatureOptions, type FeatureSetupContext } from "../public.ts";
import type { SecurityApi } from "./api.ts";
import { Exemptions } from "./exempt.ts";
import { DEFAULT_ATTACHMENT_TYPES, fileHeaders } from "./files.ts";
import { DEFAULT_CSP, DEFAULT_DOCS_CSP, headersStep } from "./headers.ts";
import { SECURITY_ITEMS, securityMiddlewares, type SecurityStep } from "./pipeline.ts";
import { proxyResolver } from "./proxy.ts";
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
  cors: toggle({}).describe("Answers cross-origin requests and preflights of the allowed origins."),
  limits: toggle({}).describe("Refuses oversized URLs, headers and bodies before reading them."),
  timeouts: toggle({}).describe("Closes idle connections and requests whose body arrives too slowly."),
  loadShedding: toggle({}).describe("Refuses new requests with 503 while a worker has too many in flight."),
  rateLimit: toggle({}).describe("Limits how many requests each client makes in a time window, answering 429."),
  ip: toggle({}).describe("Accepts or refuses requests by client address."),
  masking: toggle({}).describe("Keeps secret values and sensitive fields out of logs and error responses."),
});

/** The exemptions of each running setup, shared by the setup and the feature API built from the same context. */
const exemptionsOf = new WeakMap<object, Exemptions>();

/** The steps of the enabled items, in no particular order; the pipeline orders them. */
function itemSteps(ctx: FeatureSetupContext<SecurityOptions>): SecurityStep[] {
  const { options } = ctx;
  const steps: SecurityStep[] = [];
  if (options.headers.enabled) steps.push(headersStep(options.headers, ctx.config.production));
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
  tags: {
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
    const steps = itemSteps(ctx);
    if (ctx.options.files.enabled) ctx.app.configureServer({ fileHeaders: fileHeaders(ctx.options.files.attachmentTypes) });
    const proxy = ctx.options.proxy;
    // Without trusted proxies, req.ip is the peer address; production still checks for forwarded headers to warn once.
    if (proxy.enabled && (proxy.trust.length > 0 || ctx.config.production)) {
      const untrusted = (peer: string) =>
        safeLog(ctx.logger, "warn", { timestamp: new Date().toISOString(), message: "security.proxy.untrusted", peer, header: proxy.header, hint: "set security.proxy.trust if the service runs behind a proxy" });
      ctx.app.configureServer({ clientIp: proxyResolver(proxy, ctx.config.production ? untrusted : undefined) });
    }
    // Routes are indexed only when one carries a security tag, so other requests do no lookup.
    const index: RouteIndex | undefined = buildRouteIndex(taggedRoutes(), Object.keys(securityFeature.tags ?? {}));
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
