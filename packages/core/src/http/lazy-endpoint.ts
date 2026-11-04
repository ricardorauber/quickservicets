import { HttpError } from "../errors.ts";
import { jsonLogger, safeLog, type Logger } from "../logger.ts";
import type { Endpoint } from "./server.ts";

let routeLogger: Logger = jsonLogger;

/** Sets the logger failed route loads go to: the service's, once its app is created. */
export function setRouteLoadLogger(logger: Logger): void {
  routeLogger = logger;
}

const LAZY = Symbol.for("quickservicets.lazyEndpoint");

/** Whether an endpoint handler imports its module on its first request. */
export function isLazyEndpoint(handler: unknown): boolean {
  return typeof handler === "function" && (handler as { [LAZY]?: true })[LAZY] === true;
}

/**
 * An endpoint whose module is imported on the first request matching it and kept afterward, for the generated route
 * tables of lazy routes. A module that fails to import answers 500 for its route only, logs `routes.load.failed` with
 * the file, and is imported again on the next request.
 */
export function lazyEndpoint(file: string, load: () => Promise<{ default: unknown }>): Endpoint {
  let loading: Promise<Endpoint> | undefined;
  const handler: Endpoint = async (repos, req, res) => {
    loading ??= load().then(
      (module) => module.default as Endpoint,
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );
    let endpoint: Endpoint;
    try {
      endpoint = await loading;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      safeLog(routeLogger, "error", { timestamp: new Date().toISOString(), message: "routes.load.failed", file, requestId: req.id, error: { message: failure.message, stack: failure.stack } });
      throw new HttpError(500, "Route failed to load");
    }
    return endpoint(repos, req, res);
  };
  Object.defineProperty(handler, LAZY, { value: true });
  return handler;
}
