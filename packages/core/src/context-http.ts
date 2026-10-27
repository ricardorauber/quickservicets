import type { Http } from "./features/http/client.ts";

const SLOT = Symbol.for("quickservicets.http.context");
const slot = globalThis as unknown as { [SLOT]?: (requestId: string) => Http };

/**
 * Sets (or removes) how jobs and queue consumers get `ctx.http`: a client sending the run or message id as
 * `x-request-id`. The `http` native sets it while it runs.
 */
export function setContextHttp(factory: ((requestId: string) => Http) | undefined): void {
  slot[SLOT] = factory;
}

/** The `ctx.http` of a job run or queue message, undefined while the `http` native is off. */
export function contextHttp(requestId: string): Http | undefined {
  return slot[SLOT]?.(requestId);
}
