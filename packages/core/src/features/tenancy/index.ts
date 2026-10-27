import {
  afterCommit,
  currentDatabaseScope,
  enableDatabaseScopes,
  setRepositoryResolver,
  withDatabaseScope,
  repositoriesFor,
  setTenantRuns,
  inTransaction,
  runForTenant,
  tenantRepositories,
  type DatabaseScope,
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
import { isMissingTable, tenantScopes } from "./scopes.ts";
import { connectionResolver, type ConnectionOption } from "./connections.ts";
import { tenancyCommands } from "./commands.ts";
import { provision, tenantOperations, type TenantOperations, type TenantProvisionResult, type TenantWriter } from "./tenants.ts";
import { resolve } from "node:path";
import { RELAY_MIN_AGE_MS, relayState, stagedModel, stagingModels, tenantRelay } from "./relay.ts";
import { tenantPools, type PoolLease, type TenantPool, type TenantPools } from "./pools.ts";
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
  type TenantInfo,
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
  strategy: oneOf(["schema", "database"])
    .default("schema")
    .describe("Where the data of tenants that set no strategy of their own lives: a schema of the service's database per tenant, or a database per tenant."),
  schema: string()
    .default("tenant-{tenant}")
    .describe("The schema name of schema-strategy tenants without their own: `{tenant}` is replaced by the tenant id."),
  pools: object({
    max: integer().min(1).default(50).describe("Most tenant database pools each worker keeps open; the least recently used idle one closes to make room."),
    connections: integer().min(1).default(2).describe("Connections of each tenant database pool, per worker."),
    idle: duration().default("5m").describe("How long an unused tenant database pool stays open."),
    connectTimeout: duration().default("10s").describe("How long opening a tenant database may take before the request answers 503."),
  })
    .default({ max: 50, connections: 2, idle: "5m", connectTimeout: "10s" })
    .describe("The connection pools of database-strategy tenants, per worker."),
  connection: secret()
    .optional()
    .perRequest()
    .describe(
      "The connection of database-strategy tenants without their own: a text where `{tenant}` is replaced by the tenant id, like `postgres://app@db:5432/tenant_{tenant}`, or a function of the tenant.",
    ),
  connectionService: string().optional().describe("The http.services entry asked for a tenant's connection as GET /tenants/:id/connection, after the other sources."),
  connectionCache: object({ ttl: duration().default("10m").describe("How long each worker keeps a resolved connection without a ttl of its own.") })
    .default({ ttl: "10m" })
    .describe("The per-worker cache of resolved connections."),
  relay: object({
    interval: duration()
      .default("1m")
      .describe(
        "How often each worker relays the queue and outbox rows that database-strategy tenants staged in their open pools; delivery is at least once, delayed by up to this interval after a crash, so consumers must be idempotent.",
      ),
  })
    .default({ interval: "1m" })
    .describe(
      "The relay of queue messages and outbox rows that database-strategy tenants stage in their own database: delivery is at least once, delayed by up to relay.interval after a crash, so consumers must be idempotent.",
    ),
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

/** Provisioning and migrating tenants of each setup, for the feature API and `provisionTenant`. */
const runningOf = new WeakMap<object, Pick<TenancyApi, "provision" | "migrate">>();
let running: Pick<TenancyApi, "provision" | "migrate"> | undefined;

/**
 * Creates a tenant of the database source and migrates it, like `quickservicets tenants create`, from a running service
 * (a sign-up endpoint, say); refuses an existing id with `Tenant <id> already exists`.
 */
export function provisionTenant(info: Partial<TenantInfo> & { id: string }): Promise<TenantProvisionResult> {
  if (!running) return Promise.reject(new Error("provisionTenant() needs a running service with tenancy enabled"));
  return running.provision(info);
}

/** Applies the pending migrations to one tenant, like `quickservicets migrate --tenant <id>`, from a running service. */
export function migrateTenant(id: string): Promise<TenantProvisionResult> {
  if (!running) return Promise.reject(new Error("migrateTenant() needs a running service with tenancy enabled"));
  return running.migrate(id);
}

/** The tenant database pools of each setup, for the feature API. */
const poolsOf = new WeakMap<object, TenantPools>();

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
    if (!resolved.schema.includes("{tenant}")) problems.push("tenancy.schema must contain {tenant}");
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
  jobs: "./jobs",
  commands: tenancyCommands,
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
    const root = ctx.config.database;
    if (ctx.options.strategy === "schema" && typeof root.withSchema !== "function") {
      throw new Error(`tenancy strategy "schema" needs an adapter with withSchema(); the ${root.kind ?? "configured"} adapter has none`);
    }
    const usesDatabases =
      ctx.options.strategy === "database" || Object.values(ctx.options.tenants as Record<string, { strategy?: string }>).some((tenant) => tenant?.strategy === "database");
    if (usesDatabases && typeof root.forConnection !== "function") {
      throw new Error(`tenancy strategy "database" needs an adapter with forConnection(); the ${root.kind ?? "configured"} adapter has none`);
    }
    // Each tenant's request runs in its database scope: hooks, handlers, transactions, queues and events use it.
    enableDatabaseScopes();
    setRepositoryResolver(() => currentDatabaseScope().repos, { run: () => currentDatabaseScope().repos });
    const scopes = tenantScopes({ root, models: ctx.models, defaultSchema: ctx.config.schema, template: ctx.options.schema, logger: ctx.logger });
    const poolOptions = ctx.options.pools;
    // The queue and outbox rows of a tenant database's transactions are staged there and relayed to the shared tables.
    const coreModels = new Map(stagingModels(ctx.models).map((model) => [model.key.slice("Staged".length), ctx.models.find((candidate) => candidate.key === model.key.slice("Staged".length))!]));
    const relayer = tenantRelay({ root, models: coreModels, logger: ctx.logger });
    const pools = tenantPools({
      root,
      tenantModels: [...ctx.models.filter((model) => model.tenancy === "tenant"), ...stagingModels(ctx.models)],
      // Rows a crash left between a commit and its relay move when the pool opens again.
      ...(coreModels.size > 0 ? { onOpen: (tenant: TenantInfo, pool: TenantPool) => void relayer.relay(tenant.id, pool.adapter, RELAY_MIN_AGE_MS) } : {}),
      workers: ctx.config.server.workers,
      settings: {
        max: poolOptions.max,
        connections: poolOptions.connections,
        idleMs: parseDuration(poolOptions.idle) ?? 300_000,
        connectTimeoutMs: parseDuration(poolOptions.connectTimeout) ?? 10_000,
      },
      logger: ctx.logger,
      connections: connectionResolver({
        option: ctx.options.connection as ConnectionOption,
        ...(ctx.options.connectionService ? { service: ctx.options.connectionService } : {}),
        ttlMs: parseDuration(ctx.options.connectionCache.ttl) ?? 600_000,
        logger: ctx.logger,
      }),
    });
    poolsOf.set(ctx.options, pools);
    ctx.app.onStart(() => pools.start());
    let relayTimer: ReturnType<typeof setInterval> | undefined;
    if (coreModels.size > 0) {
      ctx.app.onStart(() => {
        relayTimer = setInterval(() => {
          for (const pool of pools.list()) void relayer.relay(pool.tenant, pool.adapter, RELAY_MIN_AGE_MS);
        }, parseDuration(ctx.options.relay.interval) ?? 60_000);
        relayTimer.unref?.();
      });
      ctx.app.onStop(() => clearInterval(relayTimer));
    }
    // Provisioning and migrating tenants from code use the project's migration files.
    const projectRoot = resolve(ctx.generated("."), "..", "..");
    let operations: TenantOperations | undefined;
    const operationsOf = () => (operations ??= tenantOperations({ config: ctx.config, models: ctx.models, projectRoot, logger: ctx.logger }));
    relayState.all = async () => {
      for await (const tenant of directory.list()) {
        if (tenant.status !== "active" || (tenant.strategy ?? ctx.options.strategy) !== "database" || coreModels.size === 0) continue;
        const lease = await pools.acquire(tenant);
        try {
          await relayer.relay(tenant.id, lease.pool.adapter, RELAY_MIN_AGE_MS);
        } finally {
          lease.release();
        }
      }
    };
    runningOf.set(ctx.options, {
      provision: (info) => provision(operationsOf(), repositoriesFor(root).tenants as unknown as TenantWriter, info as Record<string, unknown> & { id: string }),
      async migrate(id) {
        const tenant = await operationsOf().directory.find(id);
        if (!tenant) throw new Error(`Unknown tenant ${id}`);
        return { id, status: tenant.status, applied: await operationsOf().migrate(tenant) };
      },
    });
    ctx.app.onStop(() => pools.closeAll(parseDuration(ctx.config.lifecycle.stopTimeout) ?? 10_000));
    /**
     * Runs `fn` inside the database scope of a tenant: a pool of its own database, or its schema of the service's
     * database; missing tables answer 503 Tenant is not ready.
     */
    const enter = async <T>(tenant: TenantInfo, fn: (scope: DatabaseScope) => T | Promise<T>): Promise<T> => {
      const strategy = tenant.strategy ?? ctx.options.strategy;
      let lease: PoolLease | undefined;
      try {
        let scope: DatabaseScope;
        if (strategy === "database") {
          lease = await pools.acquire(tenant);
          scope = scopeOfPool(tenant, lease.pool);
        } else {
          scope = scopes.schema(tenant);
        }
        if (!(await scopes.provisioned(scope))) throw scopes.notReady(tenant);
        const entered = scope;
        return await withDatabaseScope(entered, () => fn(entered));
      } catch (error) {
        if (isMissingTable(error)) throw scopes.notReady(tenant);
        throw error;
      } finally {
        lease?.release();
      }
    };
    /** The scope of a database-strategy tenant, kept with its pool. */
    const poolScopes = new WeakMap<TenantPool, DatabaseScope>();
    const scopeOfPool = (tenant: TenantInfo, pool: TenantPool): DatabaseScope => {
      let scope = poolScopes.get(pool);
      if (!scope) {
        scope = {
          key: `tenant:${tenant.id}`,
          adapter: pool.adapter,
          repos: tenantRepositories(currentDatabaseScope().repos, pool.adapter),
          tenant: { id: tenant.id, ...(tenant.plan !== undefined ? { plan: tenant.plan } : {}) },
          // Inside the tenant's transactions, queue and outbox rows are staged in its database; outside, they go to
          // the shared tables at once.
          systemRows: (model) => {
            if (!coreModels.has(model.key) || !inTransaction()) return { adapter: root, model };
            relayer.afterCommit(tenant.id, pool.adapter);
            return { adapter: pool.adapter, model: stagedModel(model) };
          },
        };
        poolScopes.set(pool, scope);
      }
      return scope;
    };
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
        return enter(tenant, () => next());
      },
    };
    ctx.app.use(resolveTenant);
    // Jobs, queue consumers, listeners and deliveries run for a tenant through the same scopes.
    setTenantRuns({
      async run(id, fn) {
        let tenant: TenantInfo | undefined;
        try {
          tenant = await directory.find(id);
        } catch (error) {
          throw new Error(`Tenant directory is unavailable: ${(error as Error)?.message ?? String(error)}`);
        }
        if (!tenant) throw new Error(`Unknown tenant ${id}`);
        if (tenant.status === "suspended") throw new Error(`Tenant ${id} is suspended`);
        const info = tenant;
        return enter(info, (scope) => fn({ tenant: { id: info.id, ...(info.plan !== undefined ? { plan: info.plan } : {}), status: info.status, attributes: info.attributes }, repos: scope.repos }));
      },
      list: () => directory.list(),
      close: () => pools.closeAll(0),
    });
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
    running = runningOf.get(ctx.options);
    return {
      exempt: (pattern) => state.exemptions.add(pattern),
      find: (id) => state.directory.find(id),
      list: () => state.directory.list(),
      stats: () => poolsOf.get(ctx.options)!.stats(),
      provision: (info) => runningOf.get(ctx.options)!.provision(info),
      migrate: (id) => runningOf.get(ctx.options)!.migrate(id),
      run: (id, fn) => runForTenant(id, fn),
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
export { maskConnections, tenantPools } from "./pools.ts";
export { RELAY_MIN_AGE_MS, STAGED_TABLES, stagedModel, stagingModels, stagingTableStatement, tenantRelay } from "./relay.ts";
export type { RelayOptions, TenantRelay } from "./relay.ts";
export { appliedTenantMigrations, migrateTenantDatabase, migrationFiles, MONGO_MIGRATIONS_COLLECTION } from "./migrate.ts";
export { assertDatabaseSource, provision, strategyOf, tenancyOptionsOf, tenantOperations } from "./tenants.ts";
export type { TenancyOptions, TenantOperations, TenantProvisionResult, TenantWriter } from "./tenants.ts";
export type { PoolCloseReason, PoolLease, PoolSettings, PoolStats, TenantPool, TenantPools } from "./pools.ts";
