import { currentOperation } from "../public.ts";
import type { QueueClient } from "./queue.ts";
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

/**
 * The project's queues from any code: `queues.add(name, payload, options?)` adds a message, carrying the current
 * request's id when the code runs for one.
 */
export const queues: QueueClient = {
  add: (name, payload, options) => {
    const requestId = currentOperation()?.requestId;
    return queueClient(requestId ? { requestId } : {}).add(name, payload, options);
  },
};
