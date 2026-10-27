import { parseDuration } from "../public.ts";
import type { HttpModifier, HttpRequest, HttpResponse } from "./client.ts";
import { HttpClientError } from "./errors.ts";
import { copyRequest, defineModifier } from "./modifiers.ts";
import { sharedState } from "./state.ts";

/** What `withRetry` takes; every option has a default. */
export interface RetryOptions {
  /** Attempts in total, the first included (default 3). */
  attempts?: number;
  /** The first backoff, doubled for each next attempt, with full jitter (default `200ms`). */
  backoff?: string | number;
  /** The longest backoff (default `5s`). */
  maxBackoff?: string | number;
  /** The methods retried (default GET, HEAD, OPTIONS, PUT and DELETE; POST and PATCH also with an Idempotency-Key). */
  methods?: readonly string[];
  /** The statuses and error codes retried (default 408, 429, 502, 503, 504, NETWORK and TIMEOUT). */
  on?: readonly (number | string)[];
  /** The longest `Retry-After` the modifier waits; a longer one is not retried (default `30s`). */
  maxRetryAfter?: string | number;
}

export const RETRY_DEFAULTS = {
  attempts: 3,
  backoff: "200ms",
  maxBackoff: "5s",
  methods: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"],
  on: [408, 429, 502, 503, 504, "NETWORK", "TIMEOUT"],
  maxRetryAfter: "30s",
} as const;

/** Codes no retry ever repeats: what failed would fail again, or the call must not be repeated. */
const NEVER = new Set(["SSRF_BLOCKED", "RESPONSE_TOO_LARGE", "CIRCUIT_OPEN", "BULKHEAD_FULL", "ABORTED", "MODIFIER_FAILED", "UNMATCHED_MOCK"]);

/** How retries wait and draw jitter; tests replace them. */
export const retryTiming = sharedState("retry-timing", () => ({
  sleep: (ms: number) => Bun.sleep(ms),
  random: () => Math.random(),
}));

const ms = (value: string | number) => (typeof value === "number" ? value : (parseDuration(value) ?? 0));

/** The wait a `Retry-After` header asks for, in milliseconds: seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The backoff before attempt `next` (2 for the first retry): full jitter over the doubled backoff, capped. */
export function backoffMs(next: number, backoff: number, maxBackoff: number, random: () => number): number {
  const ceiling = Math.min(maxBackoff, backoff * 2 ** (next - 2));
  return Math.floor(random() * ceiling);
}

const isStream = (body: HttpRequest["body"]) => typeof ReadableStream !== "undefined" && body instanceof ReadableStream;

/**
 * A modifier that retries what is safe to retry: idempotent methods (POST and PATCH only with an `Idempotency-Key`
 * header or when listed), on the listed statuses and error codes, waiting an exponential backoff with full jitter or
 * the response's `Retry-After`. Each attempt gets the call's full timeout.
 */
export function withRetry(options: RetryOptions = {}): HttpModifier {
  const attempts = Math.max(1, Math.floor(options.attempts ?? RETRY_DEFAULTS.attempts));
  const backoff = ms(options.backoff ?? RETRY_DEFAULTS.backoff);
  const maxBackoff = ms(options.maxBackoff ?? RETRY_DEFAULTS.maxBackoff);
  const methods = new Set((options.methods ?? RETRY_DEFAULTS.methods).map((method) => method.toUpperCase()));
  const on = new Set((options.on ?? RETRY_DEFAULTS.on).map((item) => (typeof item === "number" ? item : /^\d+$/.test(item) ? Number(item) : item)));
  const maxRetryAfter = ms(options.maxRetryAfter ?? RETRY_DEFAULTS.maxRetryAfter);
  const retrying = (request: HttpRequest) => {
    if (isStream(request.body) || request.signal?.aborted) return false;
    if (methods.has(request.method)) return true;
    return (request.method === "POST" || request.method === "PATCH") && request.headers.has("idempotency-key");
  };
  return defineModifier(async function retry(request, next): Promise<HttpResponse> {
    for (let attempt = request.attempt; ; attempt++) {
      const current = copyRequest(request, { attempt });
      const last = attempt - request.attempt + 1 >= attempts || !retrying(request);
      let response: HttpResponse;
      try {
        response = await next(current);
      } catch (error) {
        if (last || !(error instanceof HttpClientError) || NEVER.has(error.code) || !on.has(error.code)) throw error;
        await retryTiming.sleep(backoffMs(attempt + 1, backoff, maxBackoff, retryTiming.random));
        continue;
      }
      if (last || !on.has(response.status)) return response;
      const asked = retryAfterMs(response.headers.get("retry-after"));
      if (asked !== undefined && asked > maxRetryAfter) return response;
      await retryTiming.sleep(asked ?? backoffMs(attempt + 1, backoff, maxBackoff, retryTiming.random));
    }
  }, "retry");
}
