import { HttpError, parseDuration, safeLog, type Logger } from "../public.ts";
import { EXEMPT } from "./exempt.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";

/** The `loadShedding` item's options. */
export interface LoadSheddingOptions {
  enabled: boolean;
  maxInFlight: number;
  retryAfter: string;
}

/** The load shedding step, with the worker's count of requests in flight. */
export interface LoadSheddingStep extends SecurityStep {
  /** The requests this worker is serving now. */
  inFlight(): number;
  /** Logs the refusals not logged yet and stops the log timer. */
  stop(): void;
}

/**
 * The step of the `loadShedding` item: counts the requests in flight from the start of the request stage until the
 * pipeline returns its response, and refuses a request with 503 while the count is at `maxInFlight`. Refusals are
 * logged at most once a second, with how many there were.
 */
export function loadSheddingStep(options: LoadSheddingOptions, logger: Logger): LoadSheddingStep {
  const { maxInFlight } = options;
  const retryAfter = String(Math.max(1, Math.ceil((parseDuration(options.retryAfter) ?? 1000) / 1000)));
  let inFlight = 0;
  let refused = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (refused === 0) return;
    safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "security.load-shed", refused, maxInFlight });
    refused = 0;
  };
  return {
    name: "loadShedding",
    before(state: SecurityState) {
      if (state.exempt & EXEMPT.loadShedding) return;
      if (inFlight >= maxInFlight) {
        refused++;
        if (timer === undefined) {
          timer = setTimeout(flush, 1000);
          (timer as { unref?: () => void }).unref?.();
        }
        throw state.refuse("loadShedding", new HttpError(503, "Server is busy", { headers: { "retry-after": retryAfter } }));
      }
      inFlight++;
      state.counted = true;
    },
    done(state: SecurityState) {
      if (!state.counted) return;
      state.counted = false;
      inFlight--;
    },
    inFlight: () => inFlight,
    stop() {
      clearTimeout(timer);
      flush();
    },
  };
}
