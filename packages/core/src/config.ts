import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseAdapter } from "./adapter.ts";
import type { Logger } from "./logger.ts";

export const CONFIG_FILE = "quickservice.config.ts";
export const DEFAULT_PORT = 3000;

/** The project configuration written in `quickservice.config.ts`. Features add their own keys here. */
export interface ServiceConfig {
  database: DatabaseAdapter;
  server?: { port?: number };
  production?: boolean;
  /** Receives one entry per request; defaults to JSON lines on stdout. */
  logger?: Logger;
  /** Default database schema for entities without an explicit one; `DATABASE_SCHEMA` overrides it. */
  schema?: string;
  migrations?: {
    /** Whether `quickservice dev` creates migrations automatically for model changes (default true). */
    autoInDev?: boolean;
  };
}

/** The configuration with every default applied. */
export interface ResolvedConfig extends Omit<ServiceConfig, "server" | "production" | "schema"> {
  server: { port: number };
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

export function resolveConfig(config: ServiceConfig, env: Record<string, string | undefined> = process.env): ResolvedConfig {
  if (!config || typeof config !== "object" || !config.database) {
    throw new ConfigError("Invalid config: database is required");
  }
  return {
    ...config,
    server: { ...config.server, port: resolvePort(config, env) },
    production: config.production ?? env.NODE_ENV === "production",
    schema: resolveSchema(config, env),
  };
}

export async function loadConfig(projectRoot: string, env: Record<string, string | undefined> = process.env): Promise<ResolvedConfig> {
  const file = join(projectRoot, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new ConfigError(`Config file not found: ${file}`);
  }
  const module = (await import(file)) as { default?: ServiceConfig };
  return resolveConfig(module.default as ServiceConfig, env);
}
