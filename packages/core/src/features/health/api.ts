import type { FeatureHook } from "../public.ts";
import type { HealthCheckResult, HealthReport, HealthStatus } from "./checks.ts";

/** What a check receives: a signal aborted when the check's timeout passes. */
export interface HealthCheckInput {
  signal: AbortSignal;
}

/** A check: resolves when healthy (optionally with extra fields for its entry), throws when not. */
export type HealthCheckFunction = (input: HealthCheckInput, ctx?: undefined) => unknown | Promise<unknown>;

/** A check written in `health.checks`: a function, or an object with `critical: false` for a non-critical one. */
export type HealthCheckEntry = ((input: HealthCheckInput) => unknown | Promise<unknown>) | { check: (input: HealthCheckInput) => unknown | Promise<unknown>; critical?: boolean };

/** Options of a check a feature registers. */
export interface HealthCheckOptions {
  /** The check's time limit, as a duration like `1s` (default `health.timeout`). */
  timeout?: string;
  /** Whether a failure fails readiness (503) rather than degrading it (default true). */
  critical?: boolean;
}

/** What `beforeCheck` hooks receive; returning false skips the check for that probe. */
export interface HealthCheckStep {
  name: string;
}

/** What `afterCheck` hooks observe after each check. */
export interface HealthCheckDone {
  name: string;
  status: HealthCheckResult["status"];
  durationMs: number;
  error?: string;
}

/** What `onStatusChange` hooks observe when the overall readiness of a worker changes. */
export interface HealthStatusChange {
  from: HealthStatus;
  to: HealthStatus;
  checks: HealthReport["checks"];
}

/** The payload of the `health.status.changed` event. */
export interface HealthStatusChangedEvent {
  from: HealthStatus;
  to: HealthStatus;
  /** The names of the failing checks. */
  failing: string[];
}

/** The feature API of `health`, reached with `ctx.feature("health")` from a feature that lists `health` in `requires` or `after`. */
export interface HealthApi {
  /**
   * Adds a readiness check named `<key>.<name>` after the calling feature's key, from its setup only; startup fails
   * with `Health check <name> is defined by <owner> and <owner>` when the name is taken.
   */
  check(name: string, fn: (input: HealthCheckInput) => unknown | Promise<unknown>, options?: HealthCheckOptions): void;
  /** Runs the readiness checks now, for an endpoint that replaces the ready route; the same as `runHealthChecks()`. */
  run(): Promise<HealthReport>;
  /** Appends a `beforeCheck` hook after the config's; returning false skips the check. */
  addHook(name: "beforeCheck", fn: FeatureHook<HealthCheckStep | false, undefined>): void;
  /** Appends an `afterCheck` hook after the config's. */
  addHook(name: "afterCheck", fn: FeatureHook<HealthCheckDone, undefined>): void;
  /** Appends an `onStatusChange` hook after the config's. */
  addHook(name: "onStatusChange", fn: FeatureHook<HealthStatusChange, undefined>): void;
}
