import { HttpError, toErrorResponse } from "./errors.ts";
import { flushLogs, jsonLogger, safeLog } from "./logger.ts";
import { LifecycleError } from "./lifecycle.ts";
import { initializeService, type InitializedService, type StartServiceOptions } from "./service.ts";
import type { JobRun } from "./jobs/job-run.ts";

/** What the platform says about one request or invocation. */
export interface PlatformInfo {
  /** The platform's name, like `lambda`, `azure-functions` or `cloud-run`. */
  name: string;
  /** The platform's request id, used as the request id when the request has no `x-request-id`. */
  requestId?: string;
  /** The client's address as the platform guarantees it; becomes `req.ip`. */
  clientIp?: string;
  /** The platform's raw event. */
  event?: unknown;
  /** The platform's context object. */
  context?: unknown;
  /** When the platform stops waiting, in milliseconds since the epoch. */
  deadline?: number;
}

/** What `req.platform` gives a handler on a platform target. */
export interface RequestPlatform {
  name: string;
  event: unknown;
  context: unknown;
  /** Milliseconds left before the platform's deadline, or `Infinity` without one. */
  remainingMs(): number;
}

const platforms = new WeakMap<Request, PlatformInfo>();

/** The platform data of a request the platform handler received, or undefined for a request it did not. */
export function platformOf(request: Request): RequestPlatform | undefined {
  const info = platforms.get(request);
  if (!info) return undefined;
  return { name: info.name, event: info.event, context: info.context, remainingMs: () => (info.deadline === undefined ? Infinity : Math.max(0, info.deadline - Date.now())) };
}

/** How long before the platform's deadline a request's signal aborts. */
export const DEADLINE_MARGIN_MS = 500;

/** The message of a request still running at the platform's deadline. */
export const DEADLINE_EXCEEDED = "Request exceeded the platform deadline";

/** What `createServiceHandler` takes besides the inputs of `startService`. */
export interface ServiceHandlerOptions extends StartServiceOptions {
  /**
   * Runs the job scheduler, queue consumer loops and other scheduled work in this instance (default false: a function
   * instance does only what its invocations ask).
   */
  scheduledWork?: boolean;
  /** Calls `stop()` when the process receives SIGTERM (default true). */
  handleSigterm?: boolean;
}

/** One service instance driven by a platform: requests, jobs and its stop. */
export interface ServiceHandler {
  /** Initializes the instance now: config, feature setups, the database and the `onStart` callbacks, once. */
  init(): Promise<void>;
  /** Runs a request through the service's pipeline, as the server does. */
  fetch(request: Request, platform?: PlatformInfo): Promise<Response>;
  /** Runs one job by name and resolves its run record. */
  runJob(name: string, options?: { tenant?: string }): Promise<JobRun | null>;
  /** Runs `onShutdown` and `onStop` callbacks and disconnects, within `lifecycle.stopTimeout`. */
  stop(): Promise<void>;
}

/**
 * The entry point of platform adapters: initializes the service once per instance, on the first call (concurrent first
 * calls share one initialization), and runs each `Request` through the same pipeline as the server. A failed
 * initialization rejects the call after logging `service.init.failed`, and the next call tries again.
 */
export function createServiceHandler(inputs: ServiceHandlerOptions): ServiceHandler {
  let initializing: Promise<InitializedService> | undefined;
  let stopped: Promise<void> | undefined;
  let lastScheduled = 0;
  const onSigterm = () => void handler.stop();
  const ensure = (): Promise<InitializedService> => {
    let logged = false;
    const logFailure = (error: unknown, logger = jsonLogger) => {
      if (logged) return;
      logged = true;
      const failure = error instanceof LifecycleError ? (error.cause as Error) : error instanceof Error ? error : new Error(String(error));
      safeLog(logger, "error", {
        timestamp: new Date().toISOString(),
        message: "service.init.failed",
        ...(error instanceof LifecycleError ? { feature: error.feature, phase: error.phase } : {}),
        error: { message: failure?.message ?? String(failure), stack: failure?.stack },
      });
      flushLogs();
    };
    initializing ??= initializeService(inputs, { index: 0, count: 1, runsScheduledWork: inputs.scheduledWork === true }, (error, _phase, logger) => logFailure(error, logger)).then(
      (service) => {
        if (inputs.scheduledWork) service.app.scheduler.start();
        if (inputs.handleSigterm !== false) process.once("SIGTERM", onSigterm);
        return service;
      },
      (error: unknown) => {
        initializing = undefined;
        // A failure before any feature ran (like an invalid config) has no service logger yet.
        logFailure(error);
        throw error;
      },
    );
    return initializing;
  };
  const handler: ServiceHandler = {
    async init() {
      await ensure();
    },
    async fetch(request, platform) {
      const service = await ensure();
      if (!platform) return service.app.server.fetch(request);
      const headers = new Headers(request.headers);
      if (platform.requestId && !headers.has("x-request-id")) headers.set("x-request-id", platform.requestId);
      const controller = new AbortController();
      const forwarded = new Request(request, { headers, signal: controller.signal });
      platforms.set(forwarded, platform);
      const answer = service.app.server.fetch(forwarded, platform.clientIp !== undefined ? { peer: platform.clientIp } : undefined);
      if (platform.deadline === undefined) return answer;
      const left = platform.deadline - Date.now();
      const abort = setTimeout(() => controller.abort(new HttpError(504, DEADLINE_EXCEEDED)), Math.max(0, left - DEADLINE_MARGIN_MS));
      let expire: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<Response>((resolve) => {
        expire = setTimeout(() => resolve(toErrorResponse(new HttpError(504, DEADLINE_EXCEEDED), { production: service.config.production })), Math.max(0, left));
      });
      try {
        return await Promise.race([answer, expired]);
      } finally {
        clearTimeout(abort);
        clearTimeout(expire);
      }
    },
    async runJob(name, options = {}) {
      const service = await ensure();
      if (!service.jobs.has(name)) throw new Error(`Unknown job ${name}`);
      // Each invocation is its own run, even two in one millisecond.
      lastScheduled = Math.max(Date.now(), lastScheduled + 1);
      return service.app.jobRunner.run({ job: name, trigger: "schedule", scheduledAt: new Date(lastScheduled), attempt: 1, ...(options.tenant !== undefined ? { tenant: options.tenant } : {}) });
    },
    stop() {
      if (!initializing) return Promise.resolve();
      process.off("SIGTERM", onSigterm);
      stopped ??= initializing.then((service) => service.stop(), () => undefined);
      return stopped;
    },
  };
  return handler;
}
