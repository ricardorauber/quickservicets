import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseAdapter } from "./adapter.ts";
import type { Logger } from "./logger.ts";
import { DEFAULT_MAX_FILE_SIZE, parseSize } from "./files/limits.ts";
import { localStorage } from "./storage/local.ts";
import type { StorageAdapter } from "./storage/storage.ts";

export const CONFIG_FILE = "quickservice.config.ts";
export const DEFAULT_PORT = 3000;

/** The project configuration written in `quickservice.config.ts`. Features add their own keys here. */
export interface ServiceConfig {
  /** The database adapter: `memoryAdapter()`, `sqliteAdapter(...)`, `postgresAdapter(...)` or `mongodbAdapter(...)`. */
  database: DatabaseAdapter;
  /** HTTP server settings. */
  server?: {
    /** Port to listen on (default `PORT`, then 3000). */
    port?: number;
    /** Absolute base URL of the API, used in file URLs (default: relative URLs). */
    publicUrl?: string;
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
}

/** The configuration with every default applied. */
export const DEFAULT_POPULATE_DEPTH = 2;

export interface ResolvedConfig
  extends Omit<ServiceConfig, "server" | "production" | "schema" | "populate" | "storage" | "files" | "docs"> {
  docs: { enabled: boolean };
  server: { port: number; publicUrl?: string };
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
  production: boolean;
  /** The resolved default schema, or null for the database's own default. */
  schema: string | null;
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

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

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

export function resolveConfig(
  config: ServiceConfig,
  env: Record<string, string | undefined> = process.env,
  projectRoot = process.cwd(),
): ResolvedConfig {
  if (!config || typeof config !== "object" || !config.database) {
    throw new ConfigError("Invalid config: database is required");
  }
  const production = config.production ?? env.NODE_ENV === "production";
  return {
    ...config,
    server: { ...config.server, port: resolvePort(config, env) },
    production,
    docs: { enabled: config.docs?.enabled ?? !production },
    schema: resolveSchema(config, env),
    populate: { maxDepth: config.populate?.maxDepth ?? DEFAULT_POPULATE_DEPTH },
    storage: resolveStorage(config, projectRoot),
    files: resolveFiles(config, env),
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
