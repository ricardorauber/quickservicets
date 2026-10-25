import { parseDuration, safeLog, type DatabaseAdapter, type EntityModel, type Logger } from "../public.ts";

/** One readiness check: a name, whether its failure fails readiness, its time limit and what it runs. */
export interface HealthCheck {
  name: string;
  critical: boolean;
  /** The check's time limit, as a duration like `2s`. */
  timeout: string;
  /** Resolves (healthy, optionally with extra fields for its entry) or throws (unhealthy); `signal` aborts at the timeout. */
  run(input: { signal: AbortSignal }): unknown | Promise<unknown>;
}

/** The entry of one check: its status, duration and criticality, its error, and the extra fields it resolved with. */
export interface HealthCheckResult {
  status: "ok" | "fail" | "skipped";
  durationMs: number;
  critical: boolean;
  error?: string;
  [field: string]: unknown;
}

/** The overall readiness: `fail` when a critical check failed, `degraded` when only others did, `ok` otherwise. */
export type HealthStatus = "ok" | "degraded" | "fail";

/** The result of every check of one readiness probe, the shape of the ready response. */
export interface HealthReport {
  status: HealthStatus;
  checks: Record<string, HealthCheckResult>;
}

/** Runs the checks and combines their results: the native's own runner, or a project's `health.prober`. */
export interface HealthProber {
  run(input: { checks: readonly HealthCheck[] }): HealthReport | Promise<HealthReport>;
}

/** What runs around each check: `before` returning false skips it, `after` observes its result. */
export interface CheckHooks {
  before?: (name: string) => Promise<boolean>;
  after?: (name: string, result: HealthCheckResult) => Promise<void>;
}

const BASE_FIELDS = new Set(["status", "durationMs", "critical"]);

/** The body of the ready route: each entry with its error and extra fields only when `details` is on. */
export function readyBody(report: HealthReport, details: boolean): HealthReport {
  if (details) return report;
  const checks: Record<string, HealthCheckResult> = {};
  for (const [name, result] of Object.entries(report.checks)) {
    checks[name] = Object.fromEntries(Object.entries(result).filter(([key]) => BASE_FIELDS.has(key))) as HealthCheckResult;
  }
  return { status: report.status, checks };
}

const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Runs one check within its timeout, aborting its signal when the time is up. */
export async function runCheck(check: HealthCheck, logger: Logger): Promise<HealthCheckResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timeoutMs = parseDuration(check.timeout) ?? 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome: { ok: true; fields: Record<string, unknown> } | { ok: false; error: string } = await Promise.race([
    Promise.resolve()
      .then(() => check.run({ signal: controller.signal }))
      .then(
        (value) => ({ ok: true as const, fields: isFields(value) ? value : {} }),
        (error: unknown) => ({ ok: false as const, error: (error as Error)?.message ?? String(error) }),
      ),
    new Promise<{ ok: false; error: string }>((resolve) => {
      timer = setTimeout(() => {
        const message = `Timed out after ${check.timeout}`;
        controller.abort(new DOMException(message, "TimeoutError"));
        resolve({ ok: false, error: message });
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  if (outcome.ok) {
    const extra = Object.fromEntries(Object.entries(outcome.fields).filter(([key]) => !BASE_FIELDS.has(key) && key !== "error"));
    return { status: "ok", durationMs, critical: check.critical, ...extra };
  }
  safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "health.check.failed", check: check.name, critical: check.critical, error: { message: outcome.error } });
  return { status: "fail", durationMs, critical: check.critical, error: outcome.error };
}

/** The overall status of check results. */
export function overallStatus(checks: Record<string, HealthCheckResult>): HealthStatus {
  const failed = Object.values(checks).filter((result) => result.status === "fail");
  return failed.some((result) => result.critical) ? "fail" : failed.length > 0 ? "degraded" : "ok";
}

/** Runs every check at once, with the hooks around each, and combines them into the overall status. */
export async function runChecks(checks: readonly HealthCheck[], logger: Logger, hooks: CheckHooks = {}): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async (check) => {
      if (hooks.before && !(await hooks.before(check.name))) return [check.name, { status: "skipped" as const, durationMs: 0, critical: check.critical }] as const;
      const result = await runCheck(check, logger);
      if (hooks.after) await hooks.after(check.name, result);
      return [check.name, result] as const;
    }),
  );
  const entries = Object.fromEntries(results) as Record<string, HealthCheckResult>;
  return { status: overallStatus(entries), checks: entries };
}

/** The database check: the adapter's `ping`, or reading one record of any model without it. */
export function databaseCheck(adapter: DatabaseAdapter, models: readonly EntityModel[]): () => Promise<void> {
  return async () => {
    if (adapter.ping) return adapter.ping();
    const model = models.find((candidate) => !candidate.link);
    if (!model) return;
    await adapter.findMany(model, { where: [], sort: [], limit: 1, offset: 0, withTotal: false });
  };
}

/**
 * Runs the checks at most once per `cacheMs`: probes within that time share the last report, or the one in progress;
 * 0 runs them for every probe.
 */
export function cachedChecks(run: () => Promise<HealthReport>, cacheMs: number): () => Promise<HealthReport> {
  if (cacheMs <= 0) return run;
  let last: { at: number; report: Promise<HealthReport> } | undefined;
  return () => {
    const now = performance.now();
    if (last && now - last.at < cacheMs) return last.report;
    const report = run();
    last = { at: now, report };
    // A failed run is not kept, so the next probe tries again.
    report.catch(() => (last = undefined));
    return report;
  };
}
