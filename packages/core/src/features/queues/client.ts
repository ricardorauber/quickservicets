import { currentOperation } from "../public.ts";
import type { QueueClient, Queues } from "./queue.ts";
import { runningQueues, type AddSource } from "./state.ts";

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
    const requestId = currentOperation()?.requestId;
    return queueClient(requestId ? { requestId } : {}).add(name, payload, options);
  },
  retry: (id) => call(() => runningQueues().retry(id)),
  retryDead: (queue) => call(() => runningQueues().retryDead(queue)),
};
