export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Calls `fn` once, `ms` after the last of a burst of triggers. */
export function debounce(fn: () => void, ms: number, scheduler: Scheduler = realScheduler): () => void {
  let pending: unknown;
  return () => {
    if (pending !== undefined) scheduler.clearTimeout(pending);
    pending = scheduler.setTimeout(() => {
      pending = undefined;
      fn();
    }, ms);
  };
}
