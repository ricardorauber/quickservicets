import {
  afterCommit,
  boolean,
  defineFeature,
  duration,
  HttpError,
  integer,
  list,
  object,
  observeWrites,
  oneOf,
  parseDuration,
  record,
  secret,
  string,
  type HandlerMiddleware,
  type RequestMiddleware,
  type ServiceRequest,
} from "../public.ts";
import type { TenancyApi } from "./api.ts";
import {
  cachedDirectory,
  configDirectory,
  databaseDirectory,
  directoryUnavailable,
  isTenantId,
  serviceDirectory,
  tenantEntity,
  TenantDirectoryUnavailableError,
  tenantInfoOf,
  tenantNotFound,
  tenantSuspended,
  type CachedDirectory,
  type TenantDirectory,
} from "./directory.ts";
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
  scope: oneOf(["tenant", "shared"])
    .default("tenant")
    .describe("Whether an entity's records belong to one tenant or are shared by every tenant; set per entity with @tenancy shared."),
  source: oneOf(["database", "config", "service"])
    .default("database")
    .describe("Where tenants are looked up: the Tenant table of the service's database, the tenants option, or another service through the HTTP client."),
  tenants: record(
    object({
      plan: string().optional().describe("The tenant's plan, in req.tenant.plan."),
      strategy: oneOf(["schema", "database"]).optional().describe("Where the tenant's data lives, over tenancy.strategy."),
      schema: string().optional().describe("The tenant's schema name, over the tenancy.schema template."),
      connection: secret().optional().describe("The connection of a database-strategy tenant."),
      status: oneOf(["active", "suspended"]).default("active").describe("A suspended tenant's requests answer 403."),
      attributes: record(string().describe("One attribute of the tenant.")).describe("Texts the tenant carries in req.tenant.attributes."),
    }),
  ).describe("The tenants of the config source, by id."),
  service: string().optional().describe("The http.services entry of the service source, called as GET /tenants/:id for one tenant and GET /tenants?cursor=… for pages."),
  cache: object({
    ttl: duration().default("5m").describe("How long each worker keeps a tenant it looked up."),
    negativeTtl: duration().default("30s").describe("How long each worker remembers an unknown tenant id."),
    staleTtl: duration().default("1h").describe("How long a cached tenant is still used while the directory fails."),
    maxEntries: integer().min(1).default(10000).describe("Most tenants each worker keeps; the least recently used go first."),
  })
    .default({ ttl: "5m", negativeTtl: "30s", staleTtl: "1h", maxEntries: 10000 })
    .describe("The per-worker cache of tenant lookups."),
});

/** What the setup shares with the feature API: the exempted paths and the directory. */
const statesOf = new WeakMap<object, { exemptions: TenantExemptions; directory: CachedDirectory }>();

/** The active tenant of an id, or the answer for an unknown, suspended or unreachable one. */
async function lookUp(directory: CachedDirectory, id: string) {
  let tenant;
  try {
    tenant = await directory.find(id);
  } catch (error) {
    if (error instanceof TenantDirectoryUnavailableError) throw directoryUnavailable();
    throw error;
  }
  if (!tenant) throw tenantNotFound();
  if (tenant.status === "suspended") throw tenantSuspended();
  return tenant;
}

/** The directory of the configured source with its cache, and the refresh of local writes to the Tenant table. */
function setUpDirectory(ctx: Parameters<NonNullable<typeof tenancyFeature.setup>>[0]): CachedDirectory {
  const options = ctx.options;
  let source: TenantDirectory;
  if (options.source === "database") {
    const model = ctx.models.find((candidate) => candidate.key === "Tenant");
    if (!model) throw new Error('tenancy.source is "database" but the Tenant entity is missing; rebuild and run quickservicets migration add');
    source = databaseDirectory(ctx.config.database, model);
  } else if (options.source === "config") {
    source = configDirectory(options.tenants as Record<string, Record<string, unknown>>);
  } else {
    source = serviceDirectory(options.service!);
  }
  const cache = options.cache;
  const directory = cachedDirectory(
    () => source,
    {
      ttl: parseDuration(cache.ttl) ?? 300_000,
      negativeTtl: parseDuration(cache.negativeTtl) ?? 30_000,
      staleTtl: parseDuration(cache.staleTtl) ?? 3_600_000,
      maxEntries: cache.maxEntries,
    },
    ctx.logger,
  );
  if (options.source === "database") {
    // Writes through this worker's repositories refresh its cache once they commit; other workers see them within the ttl.
    const stop = observeWrites({
      entities: ["Tenant"],
      transactional: true,
      write(change) {
        const after = change.after;
        if (after && !isTenantId(after.key)) throw new HttpError(400, "Invalid body", { details: [{ field: "key", message: "Must match ^[a-z0-9][a-z0-9-]{0,62}$" }] });
        const previous = change.before ? String(change.before.key) : undefined;
        void afterCommit(() => {
          if (previous !== undefined && previous !== after?.key) directory.remember(previous, undefined);
          if (after) directory.remember(String(after.key), tenantInfoOf(String(after.key), after));
          else if (previous !== undefined) directory.remember(previous, undefined);
        });
      },
    });
    ctx.app.onStop(stop);
  }
  return directory;
}

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
    if (resolved.source === "service" && !resolved.service) problems.push('tenancy.service is required when tenancy.source is "service"');
    if (from.includes("path")) {
      try {
        compilePathPattern(resolved.path);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    return problems;
  },
  // The Tenant table of the database source; nothing with the other sources.
  entities: ({ options }) => (options.source === "database" ? [tenantEntity()] : []),
  after: ["http"],
  tags: {
    tenancy: {
      on: ["entity", "endpoint"],
      options: ["scope", "required"],
      shorthand: "scope",
      description:
        "`@tenancy shared` makes an entity's records shared by every tenant; on an endpoint, `@tenancy off` exempts it from tenant resolution and `@tenancy required=false` lets it run without a tenant.",
      example: "/** @tenancy shared */\nexport type Plan = { name: string };",
      check: (tag, _options, target) => {
        if (target === "endpoint" && tag.scope !== undefined) return "scope applies only to entities";
        if (target === "entity" && tag.required !== undefined) return "required applies only to endpoints";
        return undefined;
      },
    },
  },
  setup(ctx) {
    const from = ctx.options.from as readonly TenantSource[];
    const exemptions = new TenantExemptions();
    const directory = setUpDirectory(ctx);
    statesOf.set(ctx.options, { exemptions, directory });
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
        const tenant = await lookUp(directory, id);
        req.tenant = { id, ...(tenant.plan !== undefined ? { plan: tenant.plan } : {}), attributes: tenant.attributes } as ServiceRequest["tenant"];
        return next();
      },
    };
    ctx.app.use(resolveTenant);
  },
  // Operations on tenant data say so, and take the tenant header when the header source is on.
  openapi(doc, { models, options, routes }) {
    const tenantEntities = new Set(models.filter((model) => model.tenancy === "tenant").map((model) => model.key));
    const header = (options.from as readonly string[]).includes("header") ? options.header : undefined;
    for (const route of routes) {
      if (!route.entity || !tenantEntities.has(route.entity)) continue;
      const path = route.path.replace(/\[([^\]]+)\]/g, "{$1}");
      const operation = (doc.paths[path] as Record<string, Record<string, unknown>> | undefined)?.[route.method.toLowerCase()];
      if (!operation) continue;
      operation["x-tenant"] = "required";
      if (!header) continue;
      const parameters = (operation.parameters ??= []) as { name: string; in: string }[];
      if (!parameters.some((parameter) => parameter.in === "header" && parameter.name.toLowerCase() === header.toLowerCase())) {
        parameters.push({ name: header, in: "header", required: true, description: "The tenant the request is for.", schema: { type: "string" } } as never);
      }
    }
    return doc;
  },
  api: (ctx): TenancyApi => {
    const state = statesOf.get(ctx.options)!;
    return {
      exempt: (pattern) => state.exemptions.add(pattern),
      find: (id) => state.directory.find(id),
      list: () => state.directory.list(),
    };
  },
});

export default tenancyFeature;
export { tenancyFeature };
export { compilePathPattern, matchPathPrefix, subdomainOf, TENANT_ID, TENANT_SOURCES } from "./resolve.ts";
export type { TenantSource } from "./resolve.ts";
export type { TenancyApi } from "./api.ts";
export { cachedDirectory, configDirectory, databaseDirectory, directoryClock, serviceDirectory, tenantEntity, TENANT_FIELDS, tenantInfoOf } from "./directory.ts";
export type { CachedDirectory, DirectoryCacheOptions, TenantDirectory, TenantInfo } from "./directory.ts";
export { crossTenancyReferences, markTenancy, SHARED_ENTITY_KEYS, withoutTenancyMarks } from "./models.ts";
