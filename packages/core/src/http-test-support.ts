import type { DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { registerProjectFeatures, type FeatureDefinition } from "./features.ts";
import type { ServiceRequest } from "./hooks.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry, Logger } from "./logger.ts";
import "./index.ts";

/** A local server for outgoing calls; `seen` lists the requests it received. */
export function upstream(handler: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      seen.push(request.clone() as unknown as Request);
      return handler(request as unknown as Request);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, seen, stop: () => server.stop(true) };
}

/** A logger keeping every entry, with its level. */
export function capturingLogger() {
  const entries: (LogEntry & { level: string })[] = [];
  const at = (level: string) => (entry: LogEntry) => void entries.push({ ...entry, level });
  const logger: Logger = { info: at("info"), warn: at("warn"), error: at("error") };
  return { logger, entries };
}

/** A port nothing listens on. */
export function closedPort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

type Handler = (req: ServiceRequest) => unknown;

/**
 * Starts an app of `config` (with a capturing logger) whose endpoints are `routes` (`"GET /path"` to a handler) and
 * project `features`; `fetch` sends a request to it.
 */
export async function startHttpApp(
  config: Record<string, unknown>,
  routes: Record<string, Handler> = {},
  features: FeatureDefinition[] = [],
  env: Record<string, string | undefined> = {},
  database: DatabaseAdapter = memoryAdapter(),
) {
  const { logger, entries } = capturingLogger();
  registerProjectFeatures(features.map((definition) => ({ folder: definition.key, definition })));
  const keys = Object.fromEntries(features.map((definition) => [definition.key, {}]));
  const resolved = resolveConfig({ database, logger, security: false, http: { allow: ["loopback"] }, ...keys, ...config } as ServiceConfig, env);
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await database.connect([]);
  const endpoints = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(" ") as [string, string];
    return { method, path, hooks: [], handler: (_repos: unknown, req: ServiceRequest) => handler(req) };
  });
  const app = createApp({
    models: [],
    crudRoutes: [],
    endpoints: endpoints as never,
    hooks: new Map(),
    config: resolved,
    runtimeRoutes: lifecycle.routes,
    middleware: lifecycle.middleware,
    server: lifecycle.server,
  });
  await lifecycle.start({ repos: app.repos as never, server: app.server });
  return {
    config: resolved,
    entries,
    app,
    fetch: (path: string, init?: RequestInit) => app.server.fetch(new Request(`http://localhost${path}`, init)),
    async stop() {
      await lifecycle.shutdown();
      await lifecycle.stop();
      await database.disconnect();
      registerProjectFeatures([]);
    },
  };
}

/**
 * Resolves a default configuration that lets calls reach the local test servers, so the client reads it again after a
 * test changed the options.
 */
export function resetHttpConfig(http: Record<string, unknown> = { allow: ["loopback"] }): void {
  resolveConfig({ database: memoryAdapter(), http } as ServiceConfig, {});
}
