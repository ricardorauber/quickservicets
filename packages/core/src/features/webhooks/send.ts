import { STATUS_CODES } from "node:http";
import { CORE_VERSION, http, HttpClientError, parseDuration, parseSize, safeLog, type Logger } from "../public.ts";
import { signWebhook } from "./signing.ts";
import type { StoredSubscription } from "./subscriptions.ts";

/** What one attempt sent and got. */
export interface AttemptOutcome {
  ok: boolean;
  /** The receiver's status, 0 without a response. */
  status: number;
  durationMs: number;
  /** The status line or the client error's message, for failed attempts. */
  error?: string;
  /** Up to `responseBodyLimit` of the response body. */
  response?: string;
  /** Set when the delivery must end now, without retries. */
  final?: boolean;
}

/** The headers of one attempt: the subscription's own first, then the ones the native sets, which they never replace. */
export function attemptHeaders(input: { subscription: StoredSubscription; eventId: string; body: string; at: number; extra?: Record<string, string> }): Record<string, string> {
  const timestamp = Math.floor(input.at / 1000);
  const signatures = [signWebhook({ id: input.eventId, timestamp, body: input.body, secret: input.subscription.secret })];
  const previousUntil = input.subscription.previousSecretExpiresAt ? new Date(input.subscription.previousSecretExpiresAt).getTime() : 0;
  if (input.subscription.previousSecret && previousUntil > input.at) signatures.push(signWebhook({ id: input.eventId, timestamp, body: input.body, secret: input.subscription.previousSecret }));
  const native: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `quickservicets-webhooks/${CORE_VERSION}`,
    "webhook-id": input.eventId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
  };
  const reserved = new Set(Object.keys(native));
  const own = Object.entries({ ...(input.extra ?? {}), ...(input.subscription.headers ?? {}) }).filter(([name]) => !reserved.has(name.toLowerCase()));
  return { ...Object.fromEntries(own), ...native };
}

/** The status line of an answer, like `500 Internal Server Error`. */
const statusLine = (status: number) => `${status} ${STATUS_CODES[status] ?? ""}`.trim();

/** Sends one attempt through the HTTP client: SSRF protection on, no redirects, the timeout, a bounded response. */
export async function sendAttempt(input: { url: string; body: string; headers: Record<string, string>; timeout: string; responseBodyLimit: string | number; signal?: AbortSignal }): Promise<AttemptOutcome> {
  const started = performance.now();
  const limit = typeof input.responseBodyLimit === "number" ? input.responseBodyLimit : (parseSize(input.responseBodyLimit) ?? 1024);
  const timeout = parseDuration(input.timeout) ?? 10_000;
  try {
    let builder = http.post(input.url).body(input.body).headers(input.headers).timeout(timeout).followRedirects(false);
    if (input.signal) builder = builder.signal(input.signal);
    const response = await builder.response();
    const bytes = await response.bytes();
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    const kept = new TextDecoder().decode(bytes.subarray(0, limit));
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, durationMs, response: kept };
    const error = response.status >= 300 && response.status < 400 ? "Redirects are not followed" : statusLine(response.status);
    return { ok: false, status: response.status, durationMs, error, response: kept };
  } catch (error) {
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    return { ok: false, status: 0, durationMs, error: error instanceof HttpClientError || error instanceof Error ? error.message : String(error) };
  }
}

/** Logs one attempt, never with its body or headers. */
export function logAttempt(logger: Logger, entry: { subscription: string; delivery?: string; type: string; attempt: number; outcome: AttemptOutcome }): void {
  safeLog(logger, entry.outcome.ok ? "info" : "warn", {
    timestamp: new Date().toISOString(),
    message: entry.outcome.ok ? "webhook.delivery.succeeded" : "webhook.delivery.failed",
    subscription: entry.subscription,
    ...(entry.delivery ? { delivery: entry.delivery } : {}),
    type: entry.type,
    attempt: entry.attempt,
    status: entry.outcome.status,
    durationMs: entry.outcome.durationMs,
  });
}
