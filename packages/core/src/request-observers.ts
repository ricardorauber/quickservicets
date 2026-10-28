/** What a request observer receives once a request's response is complete. */
export interface RequestObservation {
  method: string;
  /** The matched route pattern, like `/users/[id]`, or null when no route matched. */
  route: string | null;
  status: number;
  durationMs: number;
  userId?: string;
  tenantId?: string;
  /** When the request started, in milliseconds since the epoch. */
  startedAt: number;
}

/** Receives every completed request; it runs outside the response path and must not throw. */
export type RequestObserver = (observation: RequestObservation) => void;

const observers = new Set<RequestObserver>();
let list: RequestObserver[] = [];

/**
 * Calls `observer` after each request's response is complete (when the pipeline returns it, or when an SSE stream or a
 * socket closes), outside the response path; returns a function that removes it. Without observers the server does
 * no extra work.
 */
export function observeRequests(observer: RequestObserver): () => void {
  if (typeof observer !== "function") throw new Error("observeRequests() takes a function");
  observers.add(observer);
  list = [...observers];
  return () => {
    observers.delete(observer);
    list = [...observers];
  };
}

/** Whether any request observer is registered. */
export function requestsObserved(): boolean {
  return list.length > 0;
}

/** Calls every observer with an observation, after the current task, logging nothing and never throwing. */
export function notifyRequestObservers(observation: RequestObservation): void {
  const current = list;
  queueMicrotask(() => {
    for (const observer of current) {
      try {
        observer(observation);
      } catch {
        // An observer never changes a response or another observer.
      }
    }
  });
}
