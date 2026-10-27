import {
  boolean,
  defineFeature,
  list,
  object,
  oneOf,
  string,
  type HandlerMiddleware,
  type RequestMiddleware,
  type ServiceRequest,
} from "../public.ts";
import type { TenancyApi } from "./api.ts";
import {
  compilePathPattern,
  hostReader,
  invalidTenant,
  matchPathPrefix,
  subdomainOf,
  TENANT_ID,
  TENANT_SOURCES,
  TenantExemptions,
  tenantMismatch,
  tenantRequired,
  type TenantSource,
} from "./resolve.ts";

const options = object({
  from: list(oneOf(TENANT_SOURCES))
    .default(["header"])
    .describe("Where the tenant id comes from, tried in this order: header, subdomain, path, auth (set by an authentication middleware) or function."),
  header: string().default("x-tenant-id").describe("The request header that carries the tenant id for the header source."),
  domain: string().optional().describe("The base host of the subdomain source: acme.app.example.com is tenant acme when the domain is app.example.com."),
  path: string().default("/t/[tenant]").describe("The path prefix of the path source, with a [tenant] segment; it is removed before routing."),
  resolve: string()
    .optional()
    .perRequest()
    .describe("The function source: a function of the request and its user returning the tenant id or undefined; required when from lists function."),
  required: boolean().default(true).describe("Answers 400 to requests without a tenant on routes that are not exempt; @tenancy required=false relaxes one endpoint."),
});

/** What the setup shares with the feature API: the exempted paths. */
const exemptionsOf = new WeakMap<object, TenantExemptions>();

/** The tenant segment the path source found in each request, before the prefix was removed. */
const pathTenants = new WeakMap<Request, string>();

/**
 * The `tenancy` native: decides the tenant of every request from a header, a subdomain, a path prefix, the
 * authenticated credentials or a function, and puts it in `req.tenant`. Off unless `tenancy: {}` (or
 * `QS_TENANCY_ENABLED=true`) is set.
 */
const tenancyFeature = defineFeature({
  key: "tenancy",
  docs: { summary: "Multi-tenancy: every request is resolved to a tenant from a header, a subdomain, a path prefix, the credentials or a function." },
  options,
  validate(resolved) {
    const problems: string[] = [];
    const from = resolved.from as readonly TenantSource[];
    if (from.includes("subdomain") && !resolved.domain) problems.push("tenancy.domain is required when tenancy.from lists subdomain");
    if (from.includes("function") && resolved.resolve === undefined) problems.push("tenancy.resolve is required when tenancy.from lists function");
    if (from.includes("path")) {
      try {
        compilePathPattern(resolved.path);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    return problems;
  },
  tags: {
    tenancy: {
      on: ["endpoint"],
      options: ["required"],
      description: "`@tenancy off` exempts an endpoint from tenant resolution, and `@tenancy required=false` lets it run without a tenant.",
      example: "/** @tenancy off */\nexport default () => ({ status: \"ok\" });",
    },
  },
  setup(ctx) {
    const from = ctx.options.from as readonly TenantSource[];
    const exemptions = new TenantExemptions();
    exemptionsOf.set(ctx.options, exemptions);
    // The API docs and the health routes need no tenant.
    exemptions.add("/docs");
    exemptions.add("/openapi.json");
    const health = ctx.config.features.find((feature) => feature.key === "health");
    if (health) for (const path of [health.options.live, health.options.ready]) if (typeof path === "string") exemptions.add(path);
    ctx.app.onStart(() => exemptions.close());

    if (from.includes("path")) {
      const pattern = compilePathPattern(ctx.options.path);
      const strip: RequestMiddleware = {
        stage: "request",
        order: -500,
        run(stage, next) {
          const found = matchPathPrefix(pattern, stage.url.pathname);
          if (found) {
            pathTenants.set(stage.request, found.tenant);
            stage.url.pathname = found.rest;
          }
          return next();
        },
      };
      ctx.app.use(strip);
    }

    const security = ctx.config.features.find((feature) => feature.key === "security");
    const proxy = security?.options.proxy as { enabled?: boolean; trust?: readonly string[] } | undefined;
    const hostOf = hostReader(proxy);
    const domain = ctx.options.domain;
    const header = ctx.options.header;
    const resolveFn = ctx.options.resolve;
    const read: Record<TenantSource, (req: ServiceRequest, credential: string | undefined) => string | undefined | Promise<string | undefined>> = {
      header: (req) => req.headers.get(header) ?? undefined,
      subdomain: (req) => subdomainOf(hostOf(req), domain!),
      path: (req) => pathTenants.get(req.raw),
      auth: (_req, credential) => credential,
      function: async (req) => {
        // Called directly: undefined is a valid answer (no tenant), which the option's own check would refuse.
        const value = typeof resolveFn === "function" ? await (resolveFn as (ctx: object) => unknown)({ req, user: req.user, tenant: req.tenant }) : resolveFn;
        return value === undefined || value === null ? undefined : String(value);
      },
    };

    // Whether a route resolves a tenant and needs one, decided once per method and route pattern.
    const decisions = new Map<string, { exempt: boolean; required: boolean }>();
    const decide = (req: ServiceRequest) => {
      const key = `${req.method} ${req.route}`;
      let decision = decisions.get(key);
      if (!decision) {
        const target = tenancyFeature.optionsFor(req);
        decision = { exempt: target.on === false, required: target.required !== false };
        decisions.set(key, decision);
      }
      return decision;
    };

    const resolveTenant: HandlerMiddleware = {
      stage: "handler",
      // After authentication (100), before the security limits keyed by tenant (1000).
      order: 200,
      async run(req, _res, next) {
        const decision = decide(req);
        if (decision.exempt || exemptions.has(req.path)) return next();
        const credential = (req.tenant as { id?: unknown } | undefined)?.id;
        const fromCredentials = credential === undefined ? undefined : String(credential);
        let id: string | undefined;
        for (const source of from) {
          const value = await read[source](req, fromCredentials);
          if (value === undefined) continue;
          if (!TENANT_ID.test(value)) throw invalidTenant();
          if (fromCredentials !== undefined && value !== fromCredentials) throw tenantMismatch();
          id ??= value;
        }
        if (id === undefined) {
          if (decision.required) throw tenantRequired();
          return next();
        }
        req.tenant = { ...(req.tenant ?? {}), id } as ServiceRequest["tenant"];
        return next();
      },
    };
    ctx.app.use(resolveTenant);
  },
  api: (ctx): TenancyApi => ({
    exempt: (pattern) => exemptionsOf.get(ctx.options)!.add(pattern),
  }),
});

export default tenancyFeature;
export { tenancyFeature };
export { compilePathPattern, matchPathPrefix, subdomainOf, TENANT_ID, TENANT_SOURCES } from "./resolve.ts";
export type { TenantSource } from "./resolve.ts";
export type { TenancyApi } from "./api.ts";
