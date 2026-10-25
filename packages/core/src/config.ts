import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseAdapter } from "./adapter.ts";
import type { Logger } from "./logger.ts";
import { DEFAULT_MAX_FILE_SIZE, parseSize } from "./files/limits.ts";
import { parseDuration } from "./jobs/job.ts";
import { assertTimeZone, ScheduleError } from "./jobs/schedule.ts";
import { localStorage } from "./storage/local.ts";
import { availableCpus, WORKERS_ENV } from "./workers.ts";
import type { StorageAdapter } from "./storage/storage.ts";
import { ConfigError } from "./config-error.ts";
import { resolveFeatures, type NativeFeatures, type ResolvedFeature } from "./features.ts";

export const CONFIG_FILE = "quickservice.config.ts";
export const DEFAULT_PORT = 3000;

/** The project configuration written in `quickservice.config.ts`. Native features add their keys through `NativeFeatures`. */
export interface ServiceConfig extends NativeFeatures {
  /** The database adapter: `memoryAdapter()`, `sqliteAdapter(...)`, `postgresAdapter(...)` or `mongodbAdapter(...)`. */
  database: DatabaseAdapter;
  /** HTTP server settings. */
  server?: {
    /** Port to listen on (default `PORT`, then 3000). */
    port?: number;
    /** Absolute base URL of the API, used in file URLs (default: relative URLs). */
    publicUrl?: string;
    /** Processes serving requests on the shared port, an integer or `"auto"` for the CPUs available, read from the container's CPU quota on Linux (default `"auto"` in production on Linux with PostgreSQL or MongoDB, otherwise 1); `QS_WORKERS` overrides it. Above 1 it needs PostgreSQL or MongoDB, and connections spread across the processes only on Linux. */
    workers?: number | "auto";
  };
  /** Production mode: hides internal error details and disables the API docs (default `NODE_ENV === "production"`). */
  production?: boolean;
  /** API docs settings. */
  docs?: {
    /** Serve the API docs at `GET /docs` and `GET /openapi.json` (default: enabled unless `production`). */
    enabled?: boolean;
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
    /** HMAC secret of signed proxy URLs (default `FILES_SIGNING_SECRET`). */
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
    /** Most records a fluent query's `all()` may return (default 10000). */
    findAllMax?: number;
  };
  /** Populate settings. */
  populate?: {
    /** Maximum number of segments in a populate path (default 2). */
    maxDepth?: number;
  };
  /** Migration settings. */
  migrations?: {
    /** Whether `quickservice dev` creates migrations automatically for model changes (default true). */
    autoInDev?: boolean;
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
  extends Omit<ServiceConfig, "server" | "production" | "schema" | "populate" | "storage" | "files" | "docs" | "jobs"> {
  docs: { enabled: boolean };
  /** `workers` is the resolved number of processes, `"auto"` included. */
  server: { port: number; publicUrl?: string; workers: number };
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
}

const SCHEMA_NAME = /^[a-z][a-z0-9-]*$/;

function resolveSchema(config: ServiceConfig, env: Record<string, string | undefined>): string | null {
  if (env.DATABASE_SCHEMA !== undefined && env.DATABASE_SCHEMA !== "") {
    if (!SCHEMA_NAME.test(env.DATABASE_SCHEMA)) {
      throw new ConfigError(`Invalid DATABASE_SCHEMA: "${env.DATABASE_SCHEMA}" must match ^[a-z][a-z0-9-]*$`);
    }
    return env.DATABASE_SCHEMA;
  }
  if (config.schema === undefined) return null;
  if (!SCHEMA_NAME.test(config.schema)) throw new ConfigError(`Invalid schema: "${config.schema}" must match ^[a-z][a-z0-9-]*$`);
  return config.schema;
}

export { ConfigError };

export function defineConfig(config: ServiceConfig): ServiceConfig {
  return config;
}

function resolvePort(config: ServiceConfig, env: Record<string, string | undefined>): number {
  const raw = config.server?.port ?? (env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT));
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new ConfigError(`Invalid server.port: expected an integer between 1 and 65535, got ${String(config.server?.port ?? env.PORT)}`);
  }
  return raw;
}

export const WORKERS_NEED_DATABASE_SERVER = "server.workers > 1 requires a database server (PostgreSQL or MongoDB)";

/** Production services on Linux with a database server use every CPU unless told otherwise; everything else runs one process. */
function defaultWorkers(config: ServiceConfig, production: boolean, platform: string): number | "auto" {
  const kind = config.database.kind;
  return production && platform === "linux" && (kind === "postgres" || kind === "mongodb") ? "auto" : 1;
}

function resolveWorkers(
  config: ServiceConfig,
  env: Record<string, string | undefined>,
  cpus: () => number,
  production: boolean,
  platform: string,
): number {
  const fromEnv = env[WORKERS_ENV] !== undefined && env[WORKERS_ENV].trim() !== "";
  const raw: unknown = fromEnv ? env[WORKERS_ENV]!.trim() : (config.server?.workers ?? defaultWorkers(config, production, platform));
  const value = raw === "auto" ? cpus() : fromEnv && /^\d+$/.test(raw as string) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    const source = fromEnv ? `${WORKERS_ENV} (server.workers)` : "server.workers";
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

function resolveFiles(config: ServiceConfig, env: Record<string, string | undefined>): ResolvedConfig["files"] {
  const maxSize = config.files?.maxSize === undefined ? DEFAULT_MAX_FILE_SIZE : parseSize(config.files.maxSize);
  if (maxSize === undefined) throw new ConfigError(`Invalid files.maxSize: ${String(config.files?.maxSize)}`);
  const signingSecret = config.files?.signingSecret ?? (env.FILES_SIGNING_SECRET || undefined);
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

function resolveJobsEnabled(config: ServiceConfig, env: Record<string, string | undefined>): boolean {
  const raw = env.JOBS_ENABLED?.trim().toLowerCase();
  if (raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  if (raw !== undefined && raw !== "") throw new ConfigError(`Invalid JOBS_ENABLED: expected true or false, got "${env.JOBS_ENABLED}"`);
  const enabled = config.jobs?.enabled ?? JOB_DEFAULTS.enabled;
  if (typeof enabled !== "boolean") throw new ConfigError(`Invalid jobs.enabled: expected a boolean, got ${JSON.stringify(enabled)}`);
  return enabled;
}

function resolveJobs(config: ServiceConfig, env: Record<string, string | undefined>): ResolvedConfig["jobs"] {
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
    enabled: resolveJobsEnabled(config, env),
    timeZone,
    timeout: duration("timeout"),
    retries,
    retryDelay: duration("retryDelay"),
    retention: duration("retention"),
    shutdownGrace: duration("shutdownGrace"),
    limits: { result, logLines },
  };
}

export function resolveConfig(
  config: ServiceConfig,
  env: Record<string, string | undefined> = process.env,
  projectRoot = process.cwd(),
  cpus: () => number = availableCpus,
  platform: string = process.platform,
): ResolvedConfig {
  if (!config || typeof config !== "object" || !config.database) {
    throw new ConfigError("Invalid config: database is required");
  }
  const production = config.production ?? env.NODE_ENV === "production";
  const { features, disabledFeatures, enabledBy } = resolveFeatures(config as unknown as Record<string, unknown>);
  return {
    ...config,
    features,
    disabledFeatures,
    enabledBy,
    server: { ...config.server, port: resolvePort(config, env), workers: resolveWorkers(config, env, cpus, production, platform) },
    production,
    docs: { enabled: config.docs?.enabled ?? !production },
    schema: resolveSchema(config, env),
    populate: { maxDepth: config.populate?.maxDepth ?? DEFAULT_POPULATE_DEPTH },
    storage: resolveStorage(config, projectRoot),
    files: resolveFiles(config, env),
    jobs: resolveJobs(config, env),
  };
}

export async function loadConfig(projectRoot: string, env: Record<string, string | undefined> = process.env): Promise<ResolvedConfig> {
  const file = join(projectRoot, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new ConfigError(`Config file not found: ${file}`);
  }
  const module = (await import(file)) as { default?: ServiceConfig };
  return resolveConfig(module.default as ServiceConfig, env, projectRoot);
}
