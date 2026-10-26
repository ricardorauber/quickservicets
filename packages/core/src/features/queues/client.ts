import { currentOperation } from "../public.ts";
import type { QueueClient, Queues } from "./queue.ts";
import { runningQueues, type AddSource } from "./state.ts";

/** The ids of a request's user and tenant, or undefined without either. */
export function actorOfRequest(req: { user?: unknown; tenant?: unknown } | undefined): { user?: string; tenant?: string } | undefined {
  const user = (req?.user as { id?: unknown } | undefined)?.id;
  const tenant = (req?.tenant as { id?: unknown } | undefined)?.id;
  if (user === undefined && tenant === undefined) return undefined;
  return { ...(user !== undefined ? { user: String(user) } : {}), ...(tenant !== undefined ? { tenant: String(tenant) } : {}) };
}

/** A queue client whose messages carry `source`, like the request id of `req.queue`. */
export function queueClient(source: AddSource = {}): QueueClient {
  return {
    add: (name, payload, options) => {
      try {
        return runningQueues().add(name, payload, options, source);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

/** Calls the running native, turning a synchronous throw into a rejection. */
const call = <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return fn();
  } catch (error) {
    return Promise.reject(error);
  }
};

/**
 * The project's queues from any code: `queues.add(name, payload, options?)` adds a message, carrying the current
 * request's id when the code runs for one; `retry` and `retryDead` reprocess dead messages.
 */
export const queues: Queues = {
  add: (name, payload, options) => {
    const operation = currentOperation();
    const requestId = operation?.requestId;
    const actor = actorOfRequest(operation?.req);
    return queueClient({ ...(requestId ? { requestId } : {}), ...(actor ? { actor } : {}) }).add(name, payload, options);
  },
  retry: (id) => call(() => runningQueues().retry(id)),
  retryDead: (queue) => call(() => runningQueues().retryDead(queue)),
};
