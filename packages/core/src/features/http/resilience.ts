import { parseDuration, safeLog } from "../public.ts";
import { currentSettings, type HttpModifier, type HttpRequest, type HttpResponse } from "./client.ts";
import { HttpClientError } from "./errors.ts";
import { defineModifier } from "./modifiers.ts";
import { maskedUrl } from "./transport.ts";
import { sharedState } from "./state.ts";

/** What `withCircuitBreaker` takes; every option has a default. */
export interface CircuitBreakerOptions {
  /** The circuit's name (default: the service's name, else the URL's host). */
  name?: string;
  /** Failures within `window` that open the circuit (default 5). */
  failures?: number;
  /** The rolling window failures are counted in (default `30s`). */
  window?: string | number;
  /** How long an open circuit rejects calls before it lets one through (default `30s`). */
  cooldown?: string | number;
}

/** What `withBulkhead` takes; every option has a default. */
export interface BulkheadOptions {
  /** The bulkhead's name (default: the service's name, else the URL's host). */
  name?: string;
  /** Calls running at once (default 10). */
  concurrency?: number;
  /** Calls waiting for a slot (default 100). */
  queue?: number;
  /** The longest a call waits for a slot (default `5s`). */
  queueTimeout?: string | number;
}

/** The state of a circuit breaker and a bulkhead of one name in this worker. */
export interface HttpState {
  circuit: "closed" | "open" | "half-open" | undefined;
  /** Failures within the circuit's window. */
  failures: number;
  inFlight: number;
  waiting: number;
}

interface Circuit {
  state: "closed" | "open" | "half-open";
  /** When each counted failure happened. */
  failures: number[];
  openedAt: number;
  cooldownMs: number;
  windowMs: number;
  /** Whether the half-open trial call is running. */
  trial: boolean;
}

interface Bulkhead {
  inFlight: number;
  waiting: (() => void)[];
}

/** How circuits read the time; tests replace it. */
export const resilienceClock = sharedState("resilience-clock", () => ({ now: () => Date.now() }));

const circuits = sharedState("circuits", () => new Map<string, Circuit>());
const bulkheads = sharedState("bulkheads", () => new Map<string, Bulkhead>());

const ms = (value: string | number) => (typeof value === "number" ? value : (parseDuration(value) ?? 0));

/** The name a modifier keys its state by: its own, else the service's, else the URL's host. */
const keyOf = (name: string | undefined, request: HttpRequest) => name ?? request.service ?? new URL(request.url).host;

function log(level: "info" | "warn", message: string, fields: Record<string, unknown>): void {
  let settings;
  try {
    settings = currentSettings();
  } catch {
    return;
  }
  safeLog(settings.logger, level, { timestamp: new Date().toISOString(), message, ...fields });
}

function failure(code: "CIRCUIT_OPEN" | "BULKHEAD_FULL", message: string, request: HttpRequest, details?: Record<string, unknown>): HttpClientError {
  let url = request.url;
  try {
    url = maskedUrl(request.url, currentSettings());
  } catch {
    // The URL stays as given when the client is off.
  }
  return new HttpClientError({ code, message, method: request.method, url, ...(request.service !== undefined ? { service: request.service } : {}), ...(details ? { details } : {}) });
}

/** The failures of a circuit still within its window. */
function recent(circuit: Circuit, now: number): number[] {
  circuit.failures = circuit.failures.filter((at) => now - at < circuit.windowMs);
  return circuit.failures;
}

/** Whether an outcome counts against a circuit: a status of 500 and above, or a network failure or timeout. */
const isFailure = (outcome: { status?: number; error?: unknown }) =>
  outcome.error !== undefined ? outcome.error instanceof HttpClientError && (outcome.error.code === "NETWORK" || outcome.error.code === "TIMEOUT") : (outcome.status ?? 0) >= 500;

/**
 * A modifier that stops calling a failing dependency: after `failures` failures (5xx, network failures, timeouts)
 * within `window` the circuit opens and rejects calls with `CIRCUIT_OPEN` for `cooldown`; then one trial call
 * decides whether it closes or opens again. State is per name and worker.
 */
export function withCircuitBreaker(options: CircuitBreakerOptions = {}): HttpModifier {
  const threshold = Math.max(1, Math.floor(options.failures ?? 5));
  const windowMs = ms(options.window ?? "30s");
  const cooldownMs = ms(options.cooldown ?? "30s");
  return defineModifier(async function circuitBreaker(request, next): Promise<HttpResponse> {
    const name = keyOf(options.name, request);
    let circuit = circuits.get(name);
    if (!circuit) circuits.set(name, (circuit = { state: "closed", failures: [], openedAt: 0, cooldownMs, windowMs, trial: false }));
    circuit.cooldownMs = cooldownMs;
    circuit.windowMs = windowMs;
    const now = resilienceClock.now();
    if (circuit.state === "open" && now - circuit.openedAt >= cooldownMs) {
      circuit.state = "half-open";
      circuit.trial = false;
      log("info", "http.circuit.half-open", { name });
    }
    if (circuit.state === "open" || (circuit.state === "half-open" && circuit.trial)) {
      const remaining = circuit.state === "open" ? cooldownMs - (now - circuit.openedAt) : cooldownMs;
      throw failure("CIRCUIT_OPEN", `Circuit open for ${name}`, request, { retryAfter: Math.max(1, Math.ceil(remaining / 1000)) });
    }
    const trial = circuit.state === "half-open";
    if (trial) circuit.trial = true;
    const settle = (failed: boolean) => {
      const at = resilienceClock.now();
      if (trial) {
        circuit.trial = false;
        if (failed) {
          circuit.state = "open";
          circuit.openedAt = at;
          log("warn", "http.circuit.open", { name, failures: recent(circuit, at).length });
        } else {
          circuit.state = "closed";
          circuit.failures = [];
          log("info", "http.circuit.closed", { name });
        }
        return;
      }
      if (!failed || circuit.state !== "closed") return;
      circuit.failures.push(at);
      if (recent(circuit, at).length >= threshold) {
        circuit.state = "open";
        circuit.openedAt = at;
        log("warn", "http.circuit.open", { name, failures: circuit.failures.length });
      }
    };
    let response: HttpResponse;
    try {
      response = await next();
    } catch (error) {
      settle(isFailure({ error }));
      throw error;
    }
    settle(isFailure({ status: response.status }));
    return response;
  }, "circuitBreaker");
}

/**
 * A modifier that caps how many calls to a dependency run at once: `concurrency` run, `queue` more wait up to
 * `queueTimeout` (counted toward the call's timeout), and the rest reject with `BULKHEAD_FULL`. Per name and worker.
 */
export function withBulkhead(options: BulkheadOptions = {}): HttpModifier {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 10));
  const queue = Math.max(0, Math.floor(options.queue ?? 100));
  const queueTimeoutMs = ms(options.queueTimeout ?? "5s");
  return defineModifier(async function bulkhead(request, next): Promise<HttpResponse> {
    const name = keyOf(options.name, request);
    let state = bulkheads.get(name);
    if (!state) bulkheads.set(name, (state = { inFlight: 0, waiting: [] }));
    const full = () => failure("BULKHEAD_FULL", `Bulkhead full for ${name}`, request);
    let current = request;
    if (state.inFlight >= concurrency) {
      if (state.waiting.length >= queue) throw full();
      const started = performance.now();
      const limit = Math.min(queueTimeoutMs, request.timeout);
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const at = state.waiting.indexOf(wake);
          if (at >= 0) state.waiting.splice(at, 1);
          reject(full());
        }, limit);
        state.waiting.push(wake);
      });
      // The wait counts toward the call's timeout.
      current = { ...request, timeout: Math.max(1, request.timeout - (performance.now() - started)) };
    } else state.inFlight++;
    try {
      return await next(current);
    } finally {
      // A finished call hands its slot to the next waiting one, or frees it.
      const wake = state.waiting.shift();
      if (wake) wake();
      else state.inFlight--;
    }
  }, "bulkhead");
}

/** The circuit and bulkhead state of `name` in this worker, without side effects. */
export function stateOf(name: string): HttpState {
  const circuit = circuits.get(name);
  const bulkhead = bulkheads.get(name);
  const now = resilienceClock.now();
  return {
    circuit: circuit?.state,
    failures: circuit ? circuit.failures.filter((at) => now - at < circuit.windowMs).length : 0,
    inFlight: bulkhead?.inFlight ?? 0,
    waiting: bulkhead?.waiting.length ?? 0,
  };
}

/** Forgets every circuit and bulkhead; for tests. */
export function resetResilience(): void {
  circuits.clear();
  bulkheads.clear();
}
