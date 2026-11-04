import { normalizeAddress } from "../cidr.ts";
import { createServiceHandler, type ServiceHandlerOptions } from "../service-handler.ts";

/** The stop time limit a Cloud Run service uses when the project sets none, inside the 10-second grace period. */
export const CLOUD_RUN_STOP_TIMEOUT = "8s";
/** The drain delay of the health routes a Cloud Run service uses when the project sets none. */
export const CLOUD_RUN_DRAIN_DELAY = "1s";

/**
 * A project config with the stop limits Cloud Run's grace period allows where the project sets none: Cloud Run stops a
 * container 10 seconds after SIGTERM, so the defaults (10 seconds to stop, 5 to drain in production) would not fit.
 */
export function cloudRunConfig<C extends { lifecycle?: { stopTimeout?: string }; health?: unknown }>(config: C): C {
  const health = config.health;
  const healthOptions = typeof health === "object" && health !== null ? (health as { drainDelay?: string }) : health === true ? {} : undefined;
  return {
    ...config,
    lifecycle: { ...config.lifecycle, stopTimeout: config.lifecycle?.stopTimeout ?? CLOUD_RUN_STOP_TIMEOUT },
    ...(healthOptions ? { health: { ...healthOptions, drainDelay: healthOptions.drainDelay ?? CLOUD_RUN_DRAIN_DELAY } } : {}),
  };
}

/** What `runCloudRun` accepts besides the service's inputs. */
export interface CloudRunOptions {
  /** Runs the job scheduler and queue consumer loops, for services with CPU always allocated (default false). */
  scheduledWork?: boolean;
  /** Takes the client address from the right-most `x-forwarded-for` entry the front end adds (default true). */
  trustProxy?: boolean;
  /** The port (default `PORT`, then 8080). */
  port?: number;
}

/**
 * The server of the `cloud-run` target: listens on `PORT`, serves every request through the platform handler with the
 * client address Google's front end forwards, runs scheduled work only with CPU always allocated, and on SIGTERM
 * finishes what runs and exits. Resolves the server, so tests can stop it.
 */
export async function runCloudRun(inputs: ServiceHandlerOptions, options: CloudRunOptions = {}): Promise<{ port: number; stop(): Promise<void> }> {
  const handler = createServiceHandler({ ...inputs, projectConfig: cloudRunConfig(inputs.projectConfig), scheduledWork: options.scheduledWork === true, handleSigterm: false });
  await handler.init();
  const trust = options.trustProxy !== false;
  const port = options.port ?? Number(process.env.PORT ?? 8080);
  const server = Bun.serve({
    port,
    fetch(request, bun) {
      const peer = normalizeAddress(bun.requestIP(request)?.address ?? "") ?? "";
      const forwarded = trust ? request.headers.get("x-forwarded-for")?.split(",").map((entry) => entry.trim()).filter(Boolean).at(-1) : undefined;
      const clientIp = forwarded ?? peer;
      const requestId = request.headers.get("x-cloud-trace-context")?.split("/")[0];
      return handler.fetch(request, { name: "cloud-run", ...(requestId ? { requestId } : {}), ...(clientIp ? { clientIp } : {}) });
    },
  });
  const stop = async () => {
    process.off("SIGTERM", onSigterm);
    await server.stop(false);
    await handler.stop();
  };
  // Cloud Run sends SIGTERM and stops the container 10 seconds later.
  const onSigterm = () => void stop().finally(() => process.exit(0));
  if (inputs.handleSigterm !== false) process.once("SIGTERM", onSigterm);
  return { port: server.port ?? port, stop };
}
