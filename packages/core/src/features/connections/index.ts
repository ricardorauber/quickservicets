import { boolean, databaseAdapters, defineFeature, duration, hook, integer, object, oneOf, record, runAfterHooks, safeLog, jsonLogger, secret, type FeatureHook, type PoolEvent, type DatabaseAdapter, type ConnectionPoolSettings, type ResolvedConfig, type SecretReference } from "../public.ts";
import { dbCheckCommand } from "./check.ts";

/** The targets on which `mode: "auto"` means serverless. */
export const SERVERLESS_TARGETS: readonly string[] = ["lambda", "azure-functions"];

/** The pool settings of serverless mode where the project sets none. */
export const SERVERLESS_DEFAULTS = { max: 2, idleTimeout: "30s", maxLifetime: "15m", connectTimeout: "5s", lazy: true } as const;

/** The pool options, shared by the native and each named database. */
const poolShape = {
  max: integer().min(1).optional().describe("The most connections each worker opens to the database (default: the adapter's, 2 in serverless mode)."),
  idleTimeout: duration().optional().describe("How long an idle connection stays open (default: the adapter's, 30s in serverless mode)."),
  maxLifetime: duration().optional().describe("How long a connection lives before it is replaced (default: the adapter's, 15m in serverless mode)."),
  connectTimeout: duration().optional().describe("How long opening a connection may take (default: the adapter's, 5s in serverless mode)."),
  lazy: boolean().optional().describe("Opens the first connection on the first query instead of at startup (default false, true in serverless mode)."),
};

const options = object({
  mode: oneOf(["auto", "server", "serverless"] as const)
    .default("auto")
    .describe("How connections are sized: server keeps the adapter's pools, serverless uses small pools that open lazily; auto is serverless on the lambda and azure-functions deploy targets and server otherwise."),
  ...poolShape,
  proxy: oneOf(["none", "pgbouncer", "rds-proxy"] as const)
    .default("none")
    .describe("The connection proxy between the service and PostgreSQL: pgbouncer (in transaction mode) and rds-proxy turn server-side prepared statements off, and rds-proxy requires TLS."),
  direct: secret()
    .optional()
    .describe("A PostgreSQL connection URL that bypasses the proxy, used by migrations and by features that keep a session of their own (LISTEN)."),
  budget: integer().min(1).optional().describe("The connections the database grants this service; startup warns when max × workers × instances may exceed it."),
  instances: integer().min(1).default(1).describe("The most instances (servers, containers or function instances) expected at once, for the budget."),
  onConnect: hook<ConnectEvent, undefined>().describe("Runs each time a pooled connection opens, with the adapter kind, the database name and durationMs, the time from needing the connection to having it."),
  onConnectionError: hook<ConnectionErrorEvent, undefined>().describe("Runs each time a connection fails, with the adapter kind, the database name, the error and retried, true when the statement ran again on a new connection."),
  databases: record(object(poolShape).describe("The pool settings of one named database."))
    .describe("Pool settings of named databases, by name, over the settings above."),
});

/** What `onConnect` receives. */
export interface ConnectEvent {
  /** The adapter's kind, like `postgres`. */
  adapter: string;
  /** The database's name: `default`, or a name of `databases`. */
  database: string;
  durationMs: number;
}

/** What `onConnectionError` receives. */
export interface ConnectionErrorEvent {
  adapter: string;
  database: string;
  error: unknown;
  /** True when the statement ran again on a new connection. */
  retried: boolean;
}

/** The public API of the `connections` native, `ctx.feature("connections")` in a feature. */
export interface ConnectionsApi {
  /** Adds a hook after the ones written in the config. */
  addHook(name: "onConnect", fn: FeatureHook<ConnectEvent, undefined>): void;
  addHook(name: "onConnectionError", fn: FeatureHook<ConnectionErrorEvent, undefined>): void;
}

/** The resolved options of the `connections` native. */
export interface ConnectionsOptions {
  mode: "auto" | "server" | "serverless";
  max?: number;
  idleTimeout?: string;
  maxLifetime?: string;
  connectTimeout?: string;
  lazy?: boolean;
  proxy: "none" | "pgbouncer" | "rds-proxy";
  direct?: string | SecretReference;
  budget?: number;
  instances: number;
  onConnect?: FeatureHook<ConnectEvent, undefined>[];
  onConnectionError?: FeatureHook<ConnectionErrorEvent, undefined>[];
  databases: Record<string, { max?: number; idleTimeout?: string; maxLifetime?: string; connectTimeout?: string; lazy?: boolean }>;
}

/** The mode in effect for a deploy target. */
export function resolveConnectionMode(mode: ConnectionsOptions["mode"], target: string | undefined): "server" | "serverless" {
  if (mode !== "auto") return mode;
  return target !== undefined && SERVERLESS_TARGETS.includes(target) ? "serverless" : "server";
}

/**
 * The pool settings a database gets: its own `databases.<name>` entries over the native's, over the serverless
 * defaults in serverless mode; undefined in server mode when nothing is set, so the adapter keeps its own pool.
 */
export function poolSettingsFor(options: ConnectionsOptions, database: string, mode: "server" | "serverless"): ConnectionPoolSettings | undefined {
  const own = options.databases?.[database] ?? {};
  const pick = <K extends keyof ConnectionPoolSettings>(key: K) => (own as ConnectionPoolSettings)[key] ?? (options as unknown as ConnectionPoolSettings)[key] ?? (mode === "serverless" ? (SERVERLESS_DEFAULTS as unknown as ConnectionPoolSettings)[key] : undefined);
  const settings: ConnectionPoolSettings = {};
  for (const key of ["max", "idleTimeout", "maxLifetime", "connectTimeout", "lazy"] as const) {
    const value = pick(key);
    if (value !== undefined) (settings as Record<string, unknown>)[key] = value;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** The proxies' names in messages. */
const PROXY_NAMES = { pgbouncer: "PgBouncer", "rds-proxy": "RDS Proxy" } as const;

/** The startup failure of a feature that keeps a session behind a proxy without a direct connection. */
export const directConnectionNeeded = (feature: string, proxy: "pgbouncer" | "rds-proxy") =>
  `${feature} needs a direct connection because LISTEN does not work through ${PROXY_NAMES[proxy]}; set connections.direct`;

/** The startup failure of an RDS Proxy URL that turns TLS off. */
export const RDS_PROXY_TLS = "RDS Proxy needs TLS; add sslmode=require to the database URL";

/** The enabled features that keep a database session of their own, for their resolved options. */
export function sessionFeatures(config: Pick<ResolvedConfig, "features">): string[] {
  return config.features
    .filter(({ definition, options }) => (typeof definition.needsSession === "function" ? definition.needsSession(options as never) : definition.needsSession === true))
    .map(({ key }) => key);
}

/** The URL text of a PostgreSQL adapter, or undefined when it has none or its secret cannot be read yet. */
function adapterUrl(adapter: DatabaseAdapter): string | undefined {
  try {
    const url = (adapter as { url?: unknown }).url;
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a proxy cannot carry with these options: each session feature without `direct`, and an RDS Proxy URL that
 * disables TLS. Empty without a proxy.
 */
export function proxyProblems(options: Pick<ConnectionsOptions, "proxy" | "direct">, config: Pick<ResolvedConfig, "features" | "database">): string[] {
  if (options.proxy === "none") return [];
  const problems: string[] = [];
  if (options.direct === undefined) for (const feature of sessionFeatures(config)) problems.push(directConnectionNeeded(feature, options.proxy));
  if (options.proxy === "rds-proxy") {
    for (const [, adapter] of databaseAdapters(config.database)) {
      const url = adapter.kind === "postgres" ? adapterUrl(adapter) : undefined;
      if (url && /[?&]sslmode=disable(&|$)/i.test(url)) {
        problems.push(RDS_PROXY_TLS);
        break;
      }
    }
  }
  return problems;
}

/** The settings a proxy adds to a PostgreSQL pool: no prepared statements, TLS for RDS Proxy and the direct connection. */
export function proxySettings(options: Pick<ConnectionsOptions, "proxy" | "direct">): ConnectionPoolSettings | undefined {
  if (options.proxy === "none") return options.direct === undefined ? undefined : { direct: options.direct };
  return { prepare: false, ...(options.proxy === "rds-proxy" ? { tls: true } : {}), ...(options.direct !== undefined ? { direct: options.direct } : {}) };
}

/** The startup warning of a pool larger than the database's budget. */
export const budgetWarning = (connections: number, budget: number) => `connections may reach ${connections}, above connections.budget ${budget}; lower connections.max or use a connection proxy`;

/**
 * The `connections` native: sizes database connections for the platform the service runs on, so many short-lived
 * function instances never exhaust the database while long-running servers keep their pools. Enabled by default; on a
 * server target with nothing set it does nothing.
 */
export const connectionsFeature = defineFeature({
  key: "connections",
  docs: {
    summary: "Connection pool sizes for servers and functions: small, lazy pools on function targets, the adapters' pools on servers, with a budget warning.",
    sections: [
      {
        title: "Defaults by mode",
        text: [
          "| Option | Server mode | Serverless mode |",
          "| --- | --- | --- |",
          "| `max` | the adapter's (`postgresAdapter`: 10 divided across the workers; MongoDB: the driver's 100) | 2 |",
          "| `idleTimeout` | the adapter's | `30s` |",
          "| `maxLifetime` | the adapter's | `15m` |",
          "| `connectTimeout` | the adapter's | `5s` |",
          "| `lazy` | `false` | `true` |",
          "| `proxy` | `none` | `none` |",
          "",
          "`mode: \"auto\"` is serverless on the `lambda` and `azure-functions` deploy targets and server otherwise. In server mode with no option set the adapters keep exactly their own pools.",
        ].join("\n"),
      },
      {
        title: "Hooks",
        text: [
          "`onConnect` runs each time a pooled connection opens, with `{ adapter, database, durationMs }`; `onConnectionError` runs each time a connection fails, with `{ adapter, database, error, retried }`, `retried` true when the statement ran again on a new connection. Both are after-hooks: a failing hook is logged as `feature.hook.failed` and never reaches the statement. The adapters report their pool events through `onPoolEvent(listener)` only while a hook listens.",
          "",
          "```ts",
          "connections: {",
          "  onConnect: ({ database, durationMs }) => console.log(`connected to ${database} in ${durationMs} ms`),",
          "},",
          "```",
          "",
          "A feature adds hooks with `ctx.feature(\"connections\").addHook(\"onConnect\", fn)`.",
        ].join("\n"),
      },
      {
        title: "Drivers",
        text: [
          "The PostgreSQL adapter sends every statement through a `SqlExecutor`: the built-in one over `Bun.SQL`, or the one given as `postgresAdapter({ url, executor })`, like an HTTP driver.",
          "",
          "```ts",
          "interface SqlExecutor {",
          "  readonly name: string;",
          "  readonly capabilities: { interactiveTransactions: boolean; listen: boolean; preparedStatements: boolean };",
          "  query(text: string, params: readonly unknown[], options?: { signal?: AbortSignal }): Promise<Record<string, unknown>[]>;",
          "  transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>;",
          "  close(): Promise<void>;",
          "}",
          "```",
          "",
          "Errors carry the SQLSTATE as `code`. A feature needing a capability the executor lacks fails startup with `<feature> needs <capability>, which the <name> executor does not support`. `runSqlExecutorContract(create, { name, variable })` of `@quickservicets/core/testing` checks an executor against the adapter contract.",
        ].join("\n"),
      },
    ],
  },
  enabledByDefault: true,
  after: ["deploy"],
  options,
  commands: [dbCheckCommand],
  setup(ctx) {
    const resolved = ctx.options as unknown as ConnectionsOptions;
    const target = (ctx.config.features.find((feature) => feature.key === "deploy")?.options as { target?: string } | undefined)?.target;
    const mode = resolveConnectionMode(resolved.mode, target);
    let total = 0;
    const reports: Record<string, ConnectionPoolSettings> = {};
    const problems = proxyProblems(resolved, ctx.config);
    if (problems.length > 0) throw new Error(problems.join("; "));
    const proxied = proxySettings(resolved);
    for (const [name, adapter] of databaseAdapters(ctx.config.database)) {
      const sized = poolSettingsFor(resolved, name, mode);
      // A proxy stands in front of PostgreSQL only; the direct connection is the default database's.
      const extra = adapter.kind === "postgres" && proxied ? (name === "default" ? proxied : { ...proxied, direct: undefined }) : undefined;
      const settings = sized || extra ? { ...sized, ...extra } : undefined;
      if (settings && settings.direct === undefined) delete settings.direct;
      // In server mode with nothing set, the adapter keeps exactly its own pool.
      if (settings) {
        const logger = ctx.config.logger ?? jsonLogger;
        const onReconnect = (error: unknown) =>
          safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "connections.reconnected", database: name, error: { message: (error as Error)?.message ?? String(error), code: (error as { code?: unknown })?.code } });
        (adapter as DatabaseAdapter).configurePool?.({ ...settings, onReconnect });
        // The direct connection is a secret: the report only says it is set.
        const { direct, ...shown } = settings;
        reports[name] = direct === undefined ? shown : { ...shown, direct: "[set]" } as ConnectionPoolSettings;
      }
      total += settings?.max ?? 0;
    }
    if (Object.keys(reports).length > 0) safeLog(ctx.config.logger ?? jsonLogger, "info", { timestamp: new Date().toISOString(), message: "connections.pools", mode, pools: reports });
    if (resolved.budget !== undefined && total > 0) {
      const connections = total * ctx.config.server.workers * resolved.instances;
      if (connections > resolved.budget) safeLog(ctx.config.logger ?? jsonLogger, "warn", { timestamp: new Date().toISOString(), message: budgetWarning(connections, resolved.budget) });
    }
    // The adapters report their pool events only while a hook listens, so a service without hooks pays nothing.
    const unsubscribe: (() => void)[] = [];
    const hooked = () => (resolved.onConnect?.length ?? 0) + (resolved.onConnectionError?.length ?? 0) > 0;
    const subscribe = () => {
      if (unsubscribe.length > 0 || !hooked()) return;
      for (const [name, adapter] of databaseAdapters(ctx.config.database)) {
        const stop = adapter.onPoolEvent?.((event: PoolEvent) => {
          const kind = String(adapter.kind ?? "custom");
          if (event.type === "connect") void runAfterHooks(resolved.onConnect ?? [], { adapter: kind, database: name, durationMs: event.durationMs }, undefined);
          else void runAfterHooks(resolved.onConnectionError ?? [], { adapter: kind, database: name, error: event.error, retried: event.retried }, undefined);
        });
        if (stop) unsubscribe.push(stop);
      }
    };
    // Before the database connects, so the first connection is reported; hooks other features add are seen at start.
    subscribe();
    ctx.app.onStart(subscribe);
    ctx.app.onStop(() => {
      for (const stop of unsubscribe.splice(0)) stop();
    });
  },
  api: (ctx): ConnectionsApi => ({ addHook: ctx.addHook as ConnectionsApi["addHook"] }),
});

export default connectionsFeature;
