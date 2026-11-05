import { normalizeAddress } from "../cidr.ts";
import { answerPlatformEvent, createServiceHandler, type ServiceHandlerOptions } from "../service-handler.ts";
import { dispatchPlatformEvent } from "../features/triggers/state.ts";

/** What `runAzureFunctions` accepts besides the service's inputs. */
export interface AzureFunctionsOptions {
  /** The timer functions the build wrote, by function name, with the job each one runs. */
  jobs?: Readonly<Record<string, string>>;
  /** The trigger functions the build wrote, by function name, with the trigger each one runs. */
  triggers?: Readonly<Record<string, string>>;
  /** The port (default `FUNCTIONS_CUSTOMHANDLER_PORT`, then `PORT`). */
  port?: number;
}

/** The answer a custom handler gives the Functions host for a non-HTTP invocation. */
export interface InvocationResult {
  Outputs: Record<string, unknown>;
  Logs: string[];
  ReturnValue: unknown;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The client address of a request the Functions host forwarded: the right-most `x-forwarded-for` entry, without its port. */
export function forwardedClient(header: string | null): string | undefined {
  const last = header?.split(",").map((entry) => entry.trim()).filter(Boolean).at(-1);
  if (!last) return undefined;
  // `203.0.113.9:51234` and `[2001:db8::1]:51234` carry a port; a bare IPv6 address does not.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(last);
  if (bracketed) return bracketed[1];
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(last);
  return withPort ? withPort[1] : last;
}

/**
 * The custom handler of the `azure-functions` target: listens on `FUNCTIONS_CUSTOMHANDLER_PORT` (falling back to
 * `PORT`), serves the HTTP requests the Functions host forwards through the platform handler, and answers the
 * invocations of the timer functions by running their jobs and of the trigger functions by dispatching their events. Resolves the server, so tests can stop it.
 */
export async function runAzureFunctions(inputs: ServiceHandlerOptions, options: AzureFunctionsOptions = {}): Promise<{ port: number; stop(): Promise<void> }> {
  const handler = createServiceHandler({ ...inputs, scheduledWork: false, handleSigterm: false });
  await handler.init();
  const jobs = new Map(Object.entries(options.jobs ?? {}));
  const triggers = new Map(Object.entries(options.triggers ?? {}));
  const port = options.port ?? Number(process.env.FUNCTIONS_CUSTOMHANDLER_PORT ?? process.env.PORT ?? 7071);
  const server = Bun.serve({
    port,
    async fetch(request, bun) {
      const url = new URL(request.url);
      const job = request.method === "POST" ? jobs.get(url.pathname.slice(1)) : undefined;
      if (job !== undefined) {
        // The onPlatformEvent hooks see every invocation first and may answer it.
        const invocation = await request.json().catch(() => undefined);
        const answer = await answerPlatformEvent(handler.config, "azure-functions", { function: url.pathname.slice(1), invocation });
        if (answer !== undefined) return Response.json(answer);
        try {
          const run = await handler.runJob(job);
          if (run && run.status !== "success") throw new Error(`Job ${job} ${run.status}: ${(run.error as { message?: string } | undefined)?.message ?? ""}`.trim());
          return Response.json({ Outputs: {}, Logs: [`Job ${job} completed`], ReturnValue: { status: "completed" } } satisfies InvocationResult);
        } catch (error) {
          return Response.json({ Outputs: {}, Logs: [error instanceof Error ? error.message : String(error)], ReturnValue: null } satisfies InvocationResult, { status: 500 });
        }
      }
      const trigger = request.method === "POST" ? triggers.get(url.pathname.slice(1)) : undefined;
      if (trigger !== undefined) {
        const name = url.pathname.slice(1);
        const invocation = await request.json().catch(() => undefined);
        const raw = { function: name, trigger, invocation };
        const answer = await answerPlatformEvent(handler.config, "azure-functions", raw);
        if (answer !== undefined) return Response.json(answer);
        try {
          // The function is bound to one trigger, so only that trigger receives its events.
          const dispatched = await dispatchPlatformEvent("azure-functions", raw, { triggers: [trigger] });
          if (!dispatched) throw new Error(`No trigger source recognizes the invocation of ${name}`);
          if (dispatched.error) throw dispatched.error;
          return Response.json({ Outputs: {}, Logs: [`Trigger ${trigger} handled ${dispatched.outcomes.length} events`], ReturnValue: dispatched.response ?? { status: "completed" } } satisfies InvocationResult);
        } catch (error) {
          return Response.json({ Outputs: {}, Logs: [error instanceof Error ? error.message : String(error)], ReturnValue: null } satisfies InvocationResult, { status: 500 });
        }
      }
      const peer = normalizeAddress(bun.requestIP(request)?.address ?? "") ?? "";
      // The Functions host runs on loopback and forwards the client's address; from anywhere else the peer is the client.
      const clientIp = LOOPBACK.has(peer) ? (forwardedClient(request.headers.get("x-forwarded-for")) ?? peer) : peer;
      const requestId = request.headers.get("x-ms-invocation-id") ?? request.headers.get("x-request-id") ?? undefined;
      return handler.fetch(request, { name: "azure-functions", ...(requestId ? { requestId } : {}), ...(clientIp ? { clientIp } : {}) });
    },
  });
  const stop = async () => {
    process.off("SIGTERM", onSigterm);
    await server.stop(true);
    await handler.stop();
  };
  // The Functions host stops the handler with SIGTERM: it finishes what runs and exits.
  const onSigterm = () => void stop().finally(() => process.exit(0));
  if (inputs.handleSigterm !== false) process.once("SIGTERM", onSigterm);
  return { port: server.port ?? port, stop };
}
