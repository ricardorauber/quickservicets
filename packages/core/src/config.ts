import { existsSync } from "node:fs";
import type { ServerTlsConfig } from "./tls.ts";
import { join } from "node:path";
import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import type { Logger } from "./logger.ts";
import { DEFAULT_MAX_FILE_SIZE, parseSize } from "./files/limits.ts";
import { parseDuration } from "./jobs/job.ts";
import { assertTimeZone, ScheduleError } from "./jobs/schedule.ts";
import { localStorage } from "./storage/local.ts";
import { availableCpus, SERVER_WORKERS_ENV, WORKERS_ENV } from "./workers.ts";
import type { StorageAdapter } from "./storage/storage.ts";
import { ConfigError } from "./config-error.ts";
import { configureCookies } from "./cookies.ts";
import { applyEnvironment } from "./environment.ts";
import { setHookLogger } from "./feature-hooks.ts";
import { declaredVariables, readVariables, setEnvValues, type DeclaredVariable } from "./env-vars.ts";
import { maskSecrets } from "./secrets.ts";
import type { AnyOptionSchema } from "./options.ts";
import type { Middleware } from "./middleware.ts";
import type { OpenApiDoc, ProjectOpenApiContext } from "./openapi.ts";
import { activeFeatureDefinitions, assertFeatureFolders, loadProjectFeatures, maskedFeatureKeys, resolveFeatures, type NativeFeatures, type ResolvedFeature } from "./features.ts";

export const CONFIG_FILE = "quickservicets.config.ts";
export const DEFAULT_PORT = 3000;
/** The warning a production service on the in-memory database logs at startup. */
export const MEMORY_IN_PRODUCTION = "quickservicets is using the in-memory database in production; every restart loses all data. Set database in quickservicets.config.ts.";

/** The project configuration written in `quickservicets.config.ts`. Native features add their keys through `NativeFeatures`. */
export interface ServiceConfig extends NativeFeatures {
  /** The database adapter: `memoryAdapter()`, `sqliteAdapter(...)`, `postgresAdapter(...)` or `mongodbAdapter(...)`; without it the service runs on `memoryAdapter()`, which loses its data on every restart (default: the in-memory database). */
  database?: DatabaseAdapter;
  /** HTTP server settings. */
  server?: {
    /** Port to listen on (default 3000); `PORT` overrides it. */
    port?: number;
    /** Absolute base URL of the API, used in file URLs (default: relative URLs). */
    publicUrl?: string;
    /** Processes serving requests on the shared port, an integer or `"auto"` for the CPUs available, read from the container's CPU quota on Linux (default `"auto"` in production on Linux with PostgreSQL or MongoDB, otherwise 1); `QS_WORKERS` overrides it. Above 1 it needs PostgreSQL or MongoDB, and connections spread across the processes only on Linux. */
    workers?: number | "auto";
    /** Serves HTTPS on `port` itself, for deployments without a TLS proxy; setting `cert` and `key` (or their variables) turns it on. */
    tls?: {
      /** The certificate (with its chain), as a file path or PEM text. */
      cert: string;
      /** The private key, as a file path or PEM text. */
      key: string;
      /** Certificate authorities, as file paths or PEM text, one or a list. */
      ca?: string | string[];
      /** The passphrase of an encrypted key, a secret. */
      passphrase?: string;
      /** The lowest TLS version accepted, `"TLSv1.2"` or `"TLSv1.3"` (default "TLSv1.2"). */
      minVersion?: "TLSv1.2" | "TLSv1.3";
      /** Logs a warning at startup when the certificate expires within this duration (default "14d"). */
      expiryWarning?: string;
      /** How close to expiry the certificate counts as critical for expiry monitoring (default "3d"). */
      expiryCritical?: string;
      /** Checks the certificate, key and CA files for changes and applies renewed ones without a restart (default true). */
      watch?: boolean;
      /** How often the files are checked; `SIGHUP` checks at once (default "1m"). */
      reloadInterval?: string;
    };
  };
  /** Production mode: hides internal error details and disables the API docs (default false); `NODE_ENV=production` turns it on. */
  production?: boolean;
  /** API docs settings. */
  docs?: {
    /** Serve the API docs at `GET /docs` and `GET /openapi.json` (default: enabled unless `production`). */
    enabled?: boolean;
    /** Changes the generated OpenAPI document at build time, after every feature's `openapi` function, in place or by returning a new one. */
    openapi?: (doc: OpenApiDoc, context: ProjectOpenApiContext) => OpenApiDoc | void | undefined;
  };
  /** Receives one entry per request; defaults to JSON lines on stdout. */
  logger?: Logger;
  /** Default database schema for entities without an explicit one; `DATABASE_SCHEMA` overrides it. */
  schema?: string;
  /** Named file storages; file entities use `default` unless `@storage` names another (default: a local storage in `uploads/`). */
  storage?: Record<string, StorageAdapter>;
  /** File upload and access settings. */
  files?: {
    /** Largest upload in bytes or as `10MB` (default 10 MB). */
    maxSize?: number | string;
    /** Accepted MIME patterns (default any). */
    accept?: string[];
    /** How file URLs work (default: direct when the storage has a public URL, otherwise proxy). */
    access?: "direct" | "proxy" | "signed";
    /** Lifetime of signed URLs in seconds (default 900). */
    signedUrlTtl?: number;
    /** HMAC secret of signed proxy URLs; `FILES_SIGNING_SECRET` sets it. */
    signingSecret?: string;
    /** Delete a file record's object when the record is deleted (default true). */
    deleteOnRemove?: boolean;
    /** Delete replaced content and files no longer referenced after a reference changes (default true). */
    deleteReplaced?: boolean;
    /** Delete the files a record references when the record is deleted (default true). */
    deleteWithOwner?: boolean;
  };
  /** Repository settings. */
  repositories?: {
    /** Most records a fluent query's `toArray()` may return (default 10000). */
    toArrayMax?: number;
  };
  /** Populate settings. */
  populate?: {
    /** Maximum number of segments in a populate path (default 2). */
    maxDepth?: number;
  };
  /** Migration settings. */
  migrations?: {
    /** Whether `quickservicets dev` creates migrations automatically for model changes (default true). */
    autoInDev?: boolean;
  };
  /**
   * Environment variables the service needs, by name, with their option schemas (like `{ DATABASE_URL: url(),
   * REPORT_HOUR: integer().default(6) }`); they are checked at startup and read typed from `env`.
   */
  env?: Record<string, AnyOptionSchema>;
  /** Middlewares of the `request`, `handler` and `error` stages, run after every feature's middlewares of the same stage. */
  middleware?: Middleware[];
  /** Time limits of the features' lifecycle callbacks. */
  lifecycle?: {
    /** Longest each feature `setup` and `onStart` call may take, as a duration (default "30s"). */
    startTimeout?: string;
    /** Longest each feature `onShutdown` and `onStop` call may take, as a duration (default "10s"). */
    stopTimeout?: string;
  };
  /** Scheduled job settings; each job's own options override them. */
  jobs?: {
    /** Run scheduled jobs in this instance (default true); `JOBS_ENABLED=false` overrides it. */
    enabled?: boolean;
    /** IANA time zone cron schedules are evaluated in (default "UTC"). */
    timeZone?: string;
    /** Longest a run may last, as a duration like `30s`, `10m` or `2h` (default "5m"). */
    timeout?: string;
    /** How many times a failed run is retried (default 0). */
    retries?: number;
    /** Delay before the first retry, doubled for each next one, as a duration (default "30s"). */
    retryDelay?: string;
    /** How long run records are kept, as a duration (default "30d"). */
    retention?: string;
    /** How long shutdown waits for running jobs before recording them as interrupted, as a duration (default "10s"). */
    shutdownGrace?: string;
    /** Size limits of run records. */
    limits?: {
      /** Largest result stored in a run record, in bytes or as `64KB` (default "64KB"). */
      result?: number | string;
      /** Most log lines stored in a run record (default 500). */
      logLines?: number;
    };
  };
}

/** The configuration with every default applied. */
export const DEFAULT_POPULATE_DEPTH = 2;

export interface ResolvedConfig
  extends Omit<ServiceConfig, "database" | "server" | "production" | "schema" | "populate" | "storage" | "files" | "docs" | "jobs" | "lifecycle"> {
  /** The database adapter, `memoryAdapter()` when the config names none. */
  database: DatabaseAdapter;
  /** Time limits of the features' lifecycle callbacks, as durations. */
  lifecycle: { startTimeout: string; stopTimeout: string };
  docs: { enabled: boolean; openapi?: NonNullable<ServiceConfig["docs"]>["openapi"] };
  /** `workers` is the resolved number of processes, `"auto"` included. */
  server: { port: number; publicUrl?: string; workers: number; tls?: ServerTlsConfig };
  files: {
    maxSize: number;
    accept: string[];
    access?: "direct" | "proxy" | "signed";
    signedUrlTtl: number;
    signingSecret?: string;
    deleteOnRemove: boolean;
    deleteReplaced: boolean;
    deleteWithOwner: boolean;
  };
  storage: Record<string, StorageAdapter> & { default: StorageAdapter };
  populate: { maxDepth: number };
  /** Job defaults, validated and kept as written (durations like `5m`, sizes like `64KB`). */
  jobs: {
    enabled: boolean;
    timeZone: string;
    timeout: string;
    retries: number;
    retryDelay: string;
    retention: string;
    shutdownGrace: string;
    limits: { result: number | string; logLines: number };
  };
  production: boolean;
  /** The resolved default schema, or null for the database's own default. */
  schema: string | null;
  /** The enabled features with their resolved options; every extension point reads this list. */
  features: ResolvedFeature[];
  /** The keys of the registered features that are disabled. */
  disabledFeatures: string[];
  /** The natives enabled through another feature's `enables`, with the keys of the features that listed them. */
  enabledBy: Record<string, string[]>;
  /** Problems that do not stop the service, like unknown `QS_*` variables; logged once at startup and printed by the build. */
  warnings: string[];
}

const SCHEMA_NAME = /^[a-z][a-z0-9-]*$/;

function resolveSchema(config: ServiceConfig, env: Record<string, string | undefined>): string | null {
  const name = ["QS_SCHEMA", "DATABASE_SCHEMA"].find((candidate) => env[candidate] !== undefined && env[candidate] !== "");
  if (name) {
    const value = env[name]!;
    if (!SCHEMA_NAME.test(value)) throw new ConfigError(`Invalid ${name}${name === "QS_SCHEMA" ? " (schema)" : ""}: "${value}" must match ^[a-z][a-z0-9-]*$`);
    return value;
  }
  if (config.schema === undefined) return null;
  if (!SCHEMA_NAME.test(config.schema)) throw new ConfigError(`Invalid schema: "${config.schema}" must match ^[a-z][a-z0-9-]*$`);
  return config.schema;
}

export { ConfigError };

export function defineConfig(config: ServiceConfig): ServiceConfig {
  return config;
}

/** The port; `QS_SERVER_PORT` and `PORT` are applied to the config before. */
function resolvePort(config: ServiceConfig): number {
  const raw = config.server?.port ?? DEFAULT_PORT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new ConfigError(`Invalid server.port: expected an integer between 1 and 65535, got ${String(config.server?.port)}`);
  }
  return raw;
}

export const WORKERS_NEED_DATABASE_SERVER = "server.workers > 1 requires a database server (PostgreSQL or MongoDB)";

/** Production services on Linux with a database server use every CPU unless told otherwise; everything else runs one process. */
function defaultWorkers(config: ServiceConfig & { database: DatabaseAdapter }, production: boolean, platform: string): number | "auto" {
  const kind = config.database.kind;
  return production && platform === "linux" && (kind === "postgres" || kind === "mongodb") ? "auto" : 1;
}

function resolveWorkers(
  config: ServiceConfig & { database: DatabaseAdapter },
  env: Record<string, string | undefined>,
  cpus: () => number,
  production: boolean,
  platform: string,
): number {
  // QS_SERVER_WORKERS wins over the older QS_WORKERS.
  const variable = [SERVER_WORKERS_ENV, WORKERS_ENV].find((name) => env[name] !== undefined && env[name].trim() !== "");
  const fromEnv = variable !== undefined;
  const raw: unknown = fromEnv ? env[variable]!.trim() : (config.server?.workers ?? defaultWorkers(config, production, platform));
  const value = raw === "auto" ? cpus() : fromEnv && /^\d+$/.test(raw as string) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    const source = fromEnv ? `${variable} (server.workers)` : "server.workers";
    throw new ConfigError(`Invalid ${source}: expected a positive integer or "auto", got ${JSON.stringify(raw)}`);
  }
  // Memory and SQLite hold their data in the process, so separate processes would not share it.
  const kind = config.database.kind;
  if (value > 1 && (kind === "memory" || kind === "sqlite")) throw new ConfigError(WORKERS_NEED_DATABASE_SERVER);
  return value;
}

export const DEFAULT_STORAGE_DIR = "uploads";

function resolveStorage(config: ServiceConfig, projectRoot: string): ResolvedConfig["storage"] {
  if (config.storage === undefined) return { default: localStorage({ dir: join(projectRoot, DEFAULT_STORAGE_DIR) }) };
  if (!config.storage.default) throw new ConfigError("Invalid storage.default: the storage map must contain a default storage");
  return config.storage as ResolvedConfig["storage"];
}

export const DEFAULT_SIGNED_URL_TTL = 900;

/** File settings; `FILES_SIGNING_SECRET` and the `QS_FILES_*` variables are applied to the config before. */
function resolveFiles(config: ServiceConfig): ResolvedConfig["files"] {
  const maxSize = config.files?.maxSize === undefined ? DEFAULT_MAX_FILE_SIZE : parseSize(config.files.maxSize);
  if (maxSize === undefined) throw new ConfigError(`Invalid files.maxSize: ${String(config.files?.maxSize)}`);
  const signingSecret = config.files?.signingSecret || undefined;
  return {
    maxSize,
    accept: config.files?.accept ?? ["*/*"],
    ...(config.files?.access ? { access: config.files.access } : {}),
    signedUrlTtl: config.files?.signedUrlTtl ?? DEFAULT_SIGNED_URL_TTL,
    ...(signingSecret ? { signingSecret } : {}),
    deleteOnRemove: config.files?.deleteOnRemove ?? true,
    deleteReplaced: config.files?.deleteReplaced ?? true,
    deleteWithOwner: config.files?.deleteWithOwner ?? true,
  };
}

export const JOB_DEFAULTS: ResolvedConfig["jobs"] = {
  enabled: true,
  timeZone: "UTC",
  timeout: "5m",
  retries: 0,
  retryDelay: "30s",
  retention: "30d",
  shutdownGrace: "10s",
  limits: { result: "64KB", logLines: 500 },
};

/** Whether jobs run here; `JOBS_ENABLED` and `QS_JOBS_ENABLED` are applied to the config before. */
function resolveJobsEnabled(config: ServiceConfig): boolean {
  const enabled = config.jobs?.enabled ?? JOB_DEFAULTS.enabled;
  if (typeof enabled !== "boolean") throw new ConfigError(`Invalid jobs.enabled: expected a boolean, got ${JSON.stringify(enabled)}`);
  return enabled;
}

function resolveJobs(config: ServiceConfig): ResolvedConfig["jobs"] {
  const jobs = config.jobs ?? {};
  const invalid = (key: string, expected: string, value: unknown) =>
    new ConfigError(`Invalid jobs.${key}: expected ${expected}, got ${JSON.stringify(value)}`);
  const duration = (key: "timeout" | "retryDelay" | "retention" | "shutdownGrace"): string => {
    const value = jobs[key] ?? JOB_DEFAULTS[key];
    if (parseDuration(value) === undefined) throw invalid(key, "a duration like 30s, 10m or 30d", value);
    return value;
  };
  const timeZone = jobs.timeZone ?? JOB_DEFAULTS.timeZone;
  try {
    assertTimeZone(timeZone);
  } catch (error) {
    if (error instanceof ScheduleError) throw invalid("timeZone", "an IANA time zone like America/Sao_Paulo", timeZone);
    throw error;
  }
  const retries = jobs.retries ?? JOB_DEFAULTS.retries;
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0) throw invalid("retries", "an integer of at least 0", retries);
  const result = jobs.limits?.result ?? JOB_DEFAULTS.limits.result;
  if ((typeof result !== "number" && typeof result !== "string") || parseSize(result) === undefined) {
    throw invalid("limits.result", "a size in bytes or like 64KB", result);
  }
  const logLines = jobs.limits?.logLines ?? JOB_DEFAULTS.limits.logLines;
  if (typeof logLines !== "number" || !Number.isInteger(logLines) || logLines < 1) throw invalid("limits.logLines", "an integer of at least 1", logLines);
  return {
    enabled: resolveJobsEnabled(config),
    timeZone,
    timeout: duration("timeout"),
    retries,
    retryDelay: duration("retryDelay"),
    retention: duration("retention"),
    shutdownGrace: duration("shutdownGrace"),
    limits: { result, logLines },
  };
}

export const LIFECYCLE_DEFAULTS: ResolvedConfig["lifecycle"] = { startTimeout: "30s", stopTimeout: "10s" };

function resolveLifecycle(config: ServiceConfig): ResolvedConfig["lifecycle"] {
  const resolved = { ...LIFECYCLE_DEFAULTS };
  for (const key of ["startTimeout", "stopTimeout"] as const) {
    const value = config.lifecycle?.[key] ?? LIFECYCLE_DEFAULTS[key];
    if (parseDuration(value) === undefined) throw new ConfigError(`Invalid lifecycle.${key}: expected a duration like 30s, 10m or 2h, got ${JSON.stringify(value)}`);
    resolved[key] = value;
  }
  return resolved;
}

/** The error for the config key the fluent query's `toArray()` replaced. */
export const FIND_ALL_MAX_RENAMED = "repositories.findAllMax was renamed to repositories.toArrayMax";

export function resolveConfig(
  config: ServiceConfig,
  env: Record<string, string | undefined> = process.env,
  projectRoot = process.cwd(),
  cpus: () => number = availableCpus,
  platform: string = process.platform,
): ResolvedConfig {
  if (!isConfigObject(config)) throw new ConfigError("Invalid config: expected an object");
  // A config that names no database runs on the in-memory one.
  if (!config.database) config = { ...config, database: memoryAdapter() };
  if (Object.hasOwn(config.repositories ?? {}, "findAllMax")) throw new ConfigError(FIND_ALL_MAX_RENAMED);
  // Variables win over aliases, which win over the config's values; the environment is read only here.
  const environment = applyEnvironment(config as unknown as Record<string, unknown>, env, activeFeatureDefinitions());
  const withDatabase = environment.config as unknown as ServiceConfig & { database: DatabaseAdapter };
  config = withDatabase;
  const production = config.production ?? false;
  configureCookies(production);
  const { features, disabledFeatures, enabledBy } = resolveFeatures(config as unknown as Record<string, unknown>);
  assertFeatureFolders(features);
  const variables = declaredVariables(config.env, features.map((feature) => ({ key: feature.key, env: feature.definition.env })));
  const envValues = readVariables(variables, env);
  const resolved: ResolvedConfig = {
    ...config,
    database: withDatabase.database,
    // The config keys of features print their secrets masked, like the features' resolved options.
    ...maskedFeatureKeys(config as unknown as Record<string, unknown>, features),
    features,
    disabledFeatures,
    enabledBy,
    warnings: environment.warnings,
    server: { ...config.server, port: resolvePort(config), workers: resolveWorkers(withDatabase, env, cpus, production, platform) },
    production,
    docs: { enabled: config.docs?.enabled ?? !production, ...(config.docs?.openapi ? { openapi: config.docs.openapi } : {}) },
    schema: resolveSchema(config, env),
    populate: { maxDepth: config.populate?.maxDepth ?? DEFAULT_POPULATE_DEPTH },
    storage: resolveStorage(config, projectRoot),
    files: resolveFiles(config),
    jobs: resolveJobs(config),
    lifecycle: resolveLifecycle(config),
  };
  setHookLogger(resolved.logger);
  // Published last, so `env` only ever holds the variables of a configuration that resolved.
  publishEnv(envValues, variables);
  if (resolved.files.signingSecret) maskSecrets(resolved.files as unknown as Record<string, unknown>, ["signingSecret"]);
  return resolved;
}

/** Stores the values of the declared variables of a resolved configuration, so `env` reads them. */
function publishEnv(values: Record<string, unknown>, variables: readonly DeclaredVariable[]): void {
  setEnvValues(values, variables.filter((variable) => variable.schema.kind === "secret").map((variable) => variable.name));
}

const isConfigObject = (value: unknown): value is ServiceConfig => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Loads `quickservicets.config.ts` from the project root and resolves it; a project without the file resolves `{}`,
 * so it runs on the in-memory database with every default. A file that fails to import or whose default export is not
 * an object fails with a `ConfigError` naming the file.
 */
export async function loadConfig(projectRoot: string, env: Record<string, string | undefined> = process.env): Promise<ResolvedConfig> {
  await loadProjectFeatures(projectRoot);
  return resolveConfig(await importConfigFile(projectRoot), env, projectRoot);
}

/** The default export of the project's config file, `{}` when the file does not exist. */
export async function importConfigFile(projectRoot: string): Promise<ServiceConfig> {
  const file = join(projectRoot, CONFIG_FILE);
  if (!existsSync(file)) return {};
  let module: { default?: unknown };
  try {
    module = (await import(file)) as { default?: unknown };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Invalid ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isConfigObject(module.default)) throw new ConfigError(`Invalid ${file}: the default export must be an object like defineConfig({}), got ${JSON.stringify(module.default) ?? String(module.default)}`);
  return module.default;
}
