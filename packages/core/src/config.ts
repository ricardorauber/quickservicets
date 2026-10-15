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
}

/** The configuration with every default applied. */
export interface ResolvedConfig extends Omit<ServiceConfig, "server" | "production"> {
  server: { port: number };
  production: boolean;
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
