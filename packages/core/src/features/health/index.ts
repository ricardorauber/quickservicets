import { boolean, defineFeature, duration, object, parseDuration, string, type FeatureSetupContext } from "../public.ts";
import { cachedChecks, databaseCheck, readyBody, runChecks, type HealthCheck } from "./checks.ts";

const options = object({
  live: string().default("/health/live").describe("The path of the liveness route, which answers 200 while the process serves requests."),
  ready: string().default("/health/ready").describe("The path of the readiness route, which runs the checks."),
  timeout: duration().default("2s").describe("The time limit of each check."),
  cache: duration().default("1s").describe("How long a readiness result is reused by the probes of one worker; 0s runs the checks for every probe."),
  details: boolean()
    .optional()
    .describe("Shows each check's error and extra fields in the ready response; on outside production and off in production by default."),
  log: boolean().default(false).describe("Writes a request log entry for every probe; without it only 5xx responses of the health routes are logged."),
});

/** The paths below which a route is exempt from the security items that would refuse probes. */
const EXEMPT_ITEMS = ["rateLimit", "loadShedding", "ip"] as const;

/**
 * The `health` native: a liveness route that answers without touching anything, and a readiness route that checks the
 * database and the queue, cached, safe to expose and left out of the request log. Off unless `health: {}` (or
 * `QS_HEALTH_ENABLED=true`) is set.
 */
const healthFeature = defineFeature({
  key: "health",
  docs: { summary: "Liveness and readiness routes for orchestrators and load balancers, checking the database and the queue." },
  options,
  after: ["security", "queues"],
  setup(ctx) {
    const enabled = (key: string) => ctx.config.features.some((feature) => feature.key === key);
    const checks: HealthCheck[] = [{ name: "database", critical: true, timeout: ctx.options.timeout, run: databaseCheck(ctx.config.database, ctx.models) }];
    if (enabled("queues")) {
      const queues = ctx.feature("queues");
      checks.push({ name: "queue", critical: false, timeout: ctx.options.timeout, run: () => queues.health() });
    }
    const details = ctx.options.details ?? !ctx.config.production;
    const ready = cachedChecks(() => runChecks(checks, ctx.logger), parseDuration(ctx.options.cache) ?? 1000);
    const routeOptions = { log: ctx.options.log };
    ctx.app.route("GET", ctx.options.live, () => ({ status: "ok" }), routeOptions);
    ctx.app.route(
      "GET",
      ctx.options.ready,
      async (_repos, _req, res) => {
        const report = await ready();
        res.status(report.status === "fail" ? 503 : 200);
        return readyBody(report, details);
      },
      routeOptions,
    );
    if (enabled("security")) exemptProbes(ctx);
  },
});

/** Keeps rate limits, load shedding and IP lists away from the probes. */
function exemptProbes(ctx: FeatureSetupContext<{ live: string; ready: string }>): void {
  const security = ctx.feature("security");
  const patterns = new Set(["/health/*", ctx.options.live, ctx.options.ready]);
  for (const pattern of patterns) security.exempt(pattern, EXEMPT_ITEMS);
}

export default healthFeature;
export { healthFeature };
export type { HealthCheck, HealthCheckResult, HealthReport, HealthStatus } from "./checks.ts";
