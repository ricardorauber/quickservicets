import { parseDuration, safeLog, systemClock, type JobClock, type Logger, type ServiceInstance } from "../public.ts";
import { sharedState } from "./state.ts";

/** A discovered service's `outlier` option, resolved. */
export interface OutlierSettings {
  enabled: boolean;
  failures: number;
  ejection: string;
  maxEjection: string;
  maxEjectedPercent: number;
}

/** The outlier defaults of a discovered service. */
export const OUTLIER_DEFAULTS: OutlierSettings = { enabled: true, failures: 5, ejection: "30s", maxEjection: "5m", maxEjectedPercent: 50 };

/** One instance's health in this worker. */
interface InstanceHealth {
  /** Consecutive failed attempts. */
  failures: number;
  /** Ejections in a row, for the doubling ejection time. */
  ejections: number;
  ejectedUntil?: number;
  /** Back in rotation after an ejection and not yet successful: its next failure ejects it again. */
  probation: boolean;
}

/** An instance's state in `http.state(name).instances`. */
export interface InstanceState {
  id: string;
  address: string;
  state: "ok" | "ejected" | "critical";
  inFlight: number;
  failures: number;
  ejectedUntil?: Date;
}

/** What an ejection hands its listeners: the service, the instance and when it returns. */
export interface InstanceEjection {
  service: string;
  instance: ServiceInstance;
  until: Date;
}

const health = sharedState("outliers", () => ({
  byService: new Map<string, Map<string, InstanceHealth>>(),
  panicLoggedAt: new Map<string, number>(),
  clock: systemClock as JobClock,
  listeners: new Set<(ejection: InstanceEjection) => void>(),
}));

/** Sets the clock of ejections and probes (default: the system clock), for tests. */
export function setOutlierClock(clock: JobClock = systemClock): void {
  health.clock = clock;
}

/** The clock ejections and probes use. */
export const outlierClock = (): JobClock => health.clock;

/** Forgets every instance's health; the http native calls it at start and stop. */
export function resetOutliers(): void {
  health.byService.clear();
  health.panicLoggedAt.clear();
}

/** Calls `fn` on each ejection; returns a function that stops it. */
export function onInstanceEjected(fn: (ejection: InstanceEjection) => void): () => void {
  health.listeners.add(fn);
  return () => void health.listeners.delete(fn);
}

const stateOf = (service: string, id: string): InstanceHealth => {
  let byInstance = health.byService.get(service);
  if (!byInstance) health.byService.set(service, (byInstance = new Map()));
  let entry = byInstance.get(id);
  if (!entry) byInstance.set(id, (entry = { failures: 0, ejections: 0, probation: false }));
  return entry;
};

/** Whether an instance is ejected now; an ejection that ended puts it back on probation and logs its restoration. */
export function isEjected(service: string, instance: ServiceInstance, logger: Logger): boolean {
  const entry = health.byService.get(service)?.get(instance.id);
  if (entry?.ejectedUntil === undefined) return false;
  if (health.clock.now() < entry.ejectedUntil) return true;
  delete entry.ejectedUntil;
  entry.probation = true;
  safeLog(logger, "info", { timestamp: new Date(health.clock.now()).toISOString(), message: "registry.instance.restored", service, instance: instance.id });
  return false;
}

/**
 * Records an attempt's outcome: a failure (a 5xx answer, `NETWORK` or `TIMEOUT`) counts toward ejection, which happens
 * after `failures` in a row (or the first one on probation) for `ejection` doubled per further ejection up to
 * `maxEjection`, as long as no more than `maxEjectedPercent` of the instances (at least one kept) are ejected; any
 * other outcome resets the count.
 */
export function recordOutcome(service: string, instance: ServiceInstance, failed: boolean, known: readonly ServiceInstance[], settings: OutlierSettings, logger: Logger): void {
  if (!settings.enabled) return;
  const entry = stateOf(service, instance.id);
  if (!failed) {
    entry.failures = 0;
    entry.ejections = 0;
    entry.probation = false;
    return;
  }
  entry.failures++;
  if (entry.ejectedUntil !== undefined) return;
  if (!entry.probation && entry.failures < settings.failures) return;
  const now = health.clock.now();
  const ejected = known.filter((other) => other.id !== instance.id && (health.byService.get(service)?.get(other.id)?.ejectedUntil ?? 0) > now).length;
  const allowed = Math.min(Math.floor((known.length * settings.maxEjectedPercent) / 100), known.length - 1);
  if (ejected + 1 > allowed) return;
  const base = parseDuration(settings.ejection) ?? 30_000;
  const longest = parseDuration(settings.maxEjection) ?? 300_000;
  const until = now + Math.min(base * 2 ** entry.ejections, longest);
  const failures = entry.failures;
  entry.ejections++;
  entry.failures = 0;
  entry.probation = false;
  entry.ejectedUntil = until;
  safeLog(logger, "warn", { timestamp: new Date(now).toISOString(), message: "registry.instance.ejected", service, instance: instance.id, failures, until: new Date(until).toISOString() });
  for (const listener of health.listeners) listener({ service, instance, until: new Date(until) });
}

/** Whether an attempt's outcome is a failure for ejection: 5xx answers and the `NETWORK` and `TIMEOUT` errors, never 4xx. */
export const isFailure = (outcome: { status?: number; code?: string }): boolean => (outcome.status !== undefined && outcome.status >= 500) || outcome.code === "NETWORK" || outcome.code === "TIMEOUT";

/** The panic line: logged at most once a minute per service. */
export function logPanic(service: string, logger: Logger): void {
  const now = health.clock.now();
  const last = health.panicLoggedAt.get(service);
  if (last !== undefined && now - last < 60_000) return;
  health.panicLoggedAt.set(service, now);
  safeLog(logger, "warn", { timestamp: new Date(now).toISOString(), message: "registry.panic", service });
}

/** The states of a service's known instances in this worker, for `http.state(name).instances`. */
export function instanceStates(service: string, known: readonly ServiceInstance[], inFlight: (id: string) => number): InstanceState[] {
  const now = health.clock.now();
  return known.map((instance) => {
    const entry = health.byService.get(service)?.get(instance.id);
    const ejected = entry?.ejectedUntil !== undefined && entry.ejectedUntil > now;
    return {
      id: instance.id,
      address: instance.address,
      state: ejected ? "ejected" : instance.status === "critical" ? "critical" : "ok",
      inFlight: inFlight(instance.id),
      failures: entry?.failures ?? 0,
      ...(ejected ? { ejectedUntil: new Date(entry!.ejectedUntil!) } : {}),
    };
  });
}
