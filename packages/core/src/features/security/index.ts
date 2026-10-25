import { defineFeature, object, safeLog, taggedRoutes, toggle, type FeatureOptions, type FeatureSetupContext } from "../public.ts";
import type { SecurityApi } from "./api.ts";
import { Exemptions } from "./exempt.ts";
import { SECURITY_ITEMS, securityMiddlewares, type SecurityStep } from "./pipeline.ts";
import { buildRouteIndex, type RouteIndex } from "./routes.ts";

const options = object({
  proxy: toggle({}).describe("Resolves the client address in req.ip through the proxies the project trusts."),
  headers: toggle({}).describe("Sends the standard security headers on every response."),
  files: toggle({}).describe("Sends headers on served files that keep a browser from running them as pages of the service."),
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
function itemSteps(_ctx: FeatureSetupContext<SecurityOptions>): SecurityStep[] {
  return [];
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
  setup(ctx) {
    const exemptions = new Exemptions();
    exemptionsOf.set(ctx.app, exemptions);
    const enabled = SECURITY_ITEMS.filter((item) => ctx.options[item].enabled);
    const steps = itemSteps(ctx);
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
