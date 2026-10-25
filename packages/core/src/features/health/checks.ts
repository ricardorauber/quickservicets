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

/** The result of one check, as the ready response shows it with details. */
export interface HealthCheckResult {
  status: "ok" | "fail";
  durationMs: number;
  critical: boolean;
  error?: string;
  /** The extra fields the check resolved with. */
  fields?: Record<string, unknown>;
}

/** The overall readiness: `fail` when a critical check failed, `degraded` when only others did, `ok` otherwise. */
export type HealthStatus = "ok" | "degraded" | "fail";

/** The result of every check of one readiness probe. */
export interface HealthReport {
  status: HealthStatus;
  checks: Record<string, HealthCheckResult>;
}

/** The body of the ready route: each check's entry, with its error and fields only when `details` is on. */
export function readyBody(report: HealthReport, details: boolean): { status: HealthStatus; checks: Record<string, Record<string, unknown>> } {
  const checks: Record<string, Record<string, unknown>> = {};
  for (const [name, result] of Object.entries(report.checks)) {
    checks[name] = {
      status: result.status,
      durationMs: result.durationMs,
      critical: result.critical,
      ...(details && result.error !== undefined ? { error: result.error } : {}),
      ...(details ? (result.fields ?? {}) : {}),
    };
  }
  return { status: report.status, checks };
}

/** Runs one check within its timeout, aborting its signal when the time is up. */
export async function runCheck(check: HealthCheck, logger: Logger): Promise<HealthCheckResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timeoutMs = parseDuration(check.timeout) ?? 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result: Omit<HealthCheckResult, "durationMs"> = await Promise.race([
    Promise.resolve()
      .then(() => check.run({ signal: controller.signal }))
      .then(
        (value) => ({ status: "ok" as const, critical: check.critical, ...(isFields(value) ? { fields: value } : {}) }),
        (error: unknown) => ({ status: "fail" as const, critical: check.critical, error: (error as Error)?.message ?? String(error) }),
      ),
    new Promise<Omit<HealthCheckResult, "durationMs">>((resolve) => {
      timer = setTimeout(() => {
        const message = `Timed out after ${check.timeout}`;
        controller.abort(new DOMException(message, "TimeoutError"));
        resolve({ status: "fail", critical: check.critical, error: message });
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  if (result.status === "fail") {
    safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "health.check.failed", check: check.name, critical: check.critical, error: { message: result.error } });
  }
  return { ...result, durationMs };
}

const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;

/** Runs every check at once and combines them into the overall status. */
export async function runChecks(checks: readonly HealthCheck[], logger: Logger): Promise<HealthReport> {
  const results = await Promise.all(checks.map(async (check) => [check.name, await runCheck(check, logger)] as const));
  const failed = results.filter(([, result]) => result.status === "fail");
  const status: HealthStatus = failed.some(([, result]) => result.critical) ? "fail" : failed.length > 0 ? "degraded" : "ok";
  return { status, checks: Object.fromEntries(results) };
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
